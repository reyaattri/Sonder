import './style.css';
import { Session, type FrameReport } from './app/session';
import { AudioEngine, classifyOutput } from './audio/engine';
import { DepthClient } from './depth/client';
import { CameraError, CameraSource, FileSource, ImageSource, listCameras, shouldMirror, WakeLock, type FrameSource } from './camera/source';
import { DEFAULT_SETTINGS, isWorn, loadSettings, saveSettings, type Activity, type Mount, type Settings } from './core/settings';
import { DetectionClient } from './detect/client';
import { MODELS } from './detect/detector';
import { MotionSensor } from './sensors/motion';
import { Announcer } from './speech/announcer';
import { clearOverlay, drawOverlay } from './ui/overlay';
import { drawRadar } from './ui/radar';
import { HeartRateMonitor, RunTracker } from './track/devices';
import { formatDuration, formatPace } from './track/run';
import { TrackSession, type TrackReport } from './track/trackSession';
import { drawLaneGauge, drawLaneOverlay } from './ui/laneGauge';
import { TrackSimulator } from './sim/simulator';
import { WalkSimulator } from './sim/walkSim';
import { PgSegClient } from './track/pgSegClient';
import { Listener } from './voice/listener';
import { VoiceMenu, type MenuStep } from './voice/menu';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const BASE = new URL(import.meta.env.BASE_URL, location.href).href;

let settings: Settings = loadSettings();
const audio = new AudioEngine();
const announcer = new Announcer({ polite: $('sr-polite'), assertive: $('sr-assertive') }, (d) => audio.duck(d));
const detector = new DetectionClient(BASE);
const motion = new MotionSensor();
const session = new Session(settings, audio, announcer, detector, motion);
const hr = new HeartRateMonitor();
const runTracker = new RunTracker(motion, hr);
// Track mode's "runner ahead" detector: fast model on the CPU, so the GPU stays free for 60 fps lane guidance.
const trackDetector = new DetectionClient(BASE, false);
/** Settings in effect for track mode (simulator overrides applied). */
const eff = (): Settings => (simOverrides ? { ...settings, ...simOverrides } : settings);
/** While simulating, the course settings follow the simulated course. */
let simOverrides: Partial<Settings> | null = null;
let sim: TrackSimulator | null = null;
let wsim: WalkSimulator | null = null;
const track = new TrackSession(audio, announcer, trackDetector, runTracker, () => (simOverrides ? { ...settings, ...simOverrides } : settings), motion);
const tvideo = $<HTMLVideoElement>('tvideo');
/** Google Project Guideline's segmentation model, for purple guide-line courses. */
const pgSeg = new PgSegClient(BASE);
const wakeLock = new WakeLock();
/** Depth AI for the virtual cane and echolocation (GPU when available). */
const depthClient = new DepthClient(BASE, true);
session.depthClient = depthClient;
const video = $<HTMLVideoElement>('video');
const overlay = $<HTMLCanvasElement>('overlay');
const radar = $<HTMLCanvasElement>('radar');
const dialog = $<HTMLDialogElement>('settings');
const form = $<HTMLFormElement>('settings-form');
let testVideo: File | null = null;
let modelLoading: Promise<void> | null = null;
let lastReport: FrameReport | null = null;


// ---------------------------------------------------------------------------
// Screens
// ---------------------------------------------------------------------------
type ScreenId = 'voice' | 'welcome' | 'disclaimer' | 'sound' | 'headphones' | 'status' | 'running' | 'track';
let current: ScreenId = 'welcome';

function show(id: ScreenId): void {
  current = id;
  document.querySelectorAll<HTMLElement>('.screen').forEach((s) => s.removeAttribute('data-active'));
  const el = $(`screen-${id}`);
  el.setAttribute('data-active', '');
  // Move focus to the heading so screen readers announce the new screen.
  el.querySelector<HTMLElement>('h1')?.focus();
  if (id === 'running') {
    $('pause-target').focus();
    requestAnimationFrame(radarLoop);
  }
  if (id === 'track') $('track-target').focus();
  if (id === 'sound') void refreshSound();
  if (id === 'welcome') void refreshChecks();
}

function status(title: string, text: string, opts: { retry?: boolean; busy?: boolean } = {}): void {
  $('status-title').textContent = title;
  $('status-text').textContent = text;
  $('btn-retry').hidden = !opts.retry;
  $('status-spinner').hidden = !opts.busy;
  show('status');
}

type CheckState = 'ok' | 'warn' | 'bad' | 'idle';
function setCheck(name: string, state: CheckState, text: string): void {
  document.querySelectorAll<HTMLElement>(`[data-check="${name}"]`).forEach((li) => {
    li.dataset.state = state;
    li.querySelector('.val')!.textContent = text;
  });
}

// ---------------------------------------------------------------------------
// Home: where is the phone? + ready check
// ---------------------------------------------------------------------------
const MOUNT_HINT: Record<Mount, string> = {
  chest:
    'Clip the phone to a lanyard or chest strap with the back camera facing forward. While walking, press and hold the screen to pause.',
  waist:
    'Clip the phone to your belt with the back camera facing forward, tilted slightly up. While walking, press and hold the screen to pause.',
  hand: 'Hold the phone at chest height, back camera pointing ahead. Double-tap the screen to pause.',
  table: 'Prop the phone or laptop up facing the room, for demos. Double-tap the screen to pause.',
};

function renderActivity(): void {
  document.querySelectorAll<HTMLButtonElement>('[data-activity]').forEach((b) => {
    const on = b.dataset.activity === settings.activity;
    b.setAttribute('aria-checked', String(on));
    b.tabIndex = on ? 0 : -1;
  });
  const isTrack = settings.activity === 'track';
  $('track-card').hidden = !isTrack;
  $('mount-card').hidden = isTrack;
  $('btn-start').textContent = isTrack ? 'Start run' : 'Start walking';
}

$('activity-group').addEventListener('click', (e) => {
  const a = (e.target as HTMLElement).closest<HTMLElement>('[data-activity]')?.dataset.activity as Activity | undefined;
  if (!a) return;
  update({ activity: a });
  void refreshChecks();
  announcer.showText(a === 'track' ? 'Track run selected.' : 'Walk selected.');
});
$('activity-group').addEventListener('keydown', (e) => {
  if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
  e.preventDefault();
  const a: Activity = settings.activity === 'walk' ? 'track' : 'walk';
  update({ activity: a });
  document.querySelector<HTMLButtonElement>(`[data-activity="${a}"]`)?.focus();
});

$('btn-hr').addEventListener('click', async () => {
  if (!HeartRateMonitor.supported) {
    announcer.say('This browser cannot connect to Bluetooth heart-rate monitors. Use Chrome on Android or a computer.');
    return;
  }
  try {
    await hr.connect();
    announcer.say(`Connected to ${hr.name}.`);
  } catch (e) {
    if ((e as Error).name !== 'NotFoundError') announcer.say('Could not connect to the heart-rate monitor.');
  }
  void refreshChecks();
});
hr.onChange = () => void refreshChecks();

function renderMount(): void {
  document.querySelectorAll<HTMLButtonElement>('[data-mount]').forEach((b) => {
    const on = b.dataset.mount === settings.mount;
    b.setAttribute('aria-checked', String(on));
    b.tabIndex = on ? 0 : -1;
  });
  $('mount-hint').textContent = MOUNT_HINT[settings.mount];
}

$('mount-group').addEventListener('click', (e) => {
  const m = (e.target as HTMLElement).closest<HTMLElement>('[data-mount]')?.dataset.mount as Mount | undefined;
  if (!m) return;
  update({ mount: m });
  announcer.showText(MOUNT_HINT[m]);
});
// Arrow keys move between radio options (standard radiogroup behaviour).
$('mount-group').addEventListener('keydown', (e) => {
  const order: Mount[] = ['chest', 'waist', 'hand', 'table'];
  const i = order.indexOf(settings.mount);
  const d = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
  if (!d) return;
  e.preventDefault();
  const m = order[(i + d + order.length) % order.length];
  update({ mount: m });
  document.querySelector<HTMLButtonElement>(`[data-mount="${m}"]`)?.focus();
});

async function refreshChecks(): Promise<void> {
  renderMount();
  renderActivity();
  // Track-mode checks
  try {
    const p = await navigator.permissions?.query({ name: 'geolocation' as PermissionName });
    if (p) setCheck('gps', p.state === 'denied' ? 'bad' : p.state === 'granted' ? 'ok' : 'idle', p.state === 'granted' ? 'Allowed' : p.state === 'denied' ? 'Blocked: step count used instead' : 'Asks when you start');
  } catch {
    /* unknown */
  }
  if (!HeartRateMonitor.supported) setCheck('hr', 'idle', 'Not supported in this browser');
  else setCheck('hr', hr.connected ? 'ok' : 'idle', hr.connected ? `${hr.name}${hr.current ? `, ${hr.current} bpm` : ''}` : 'Not connected (optional)');
  setCheck('haptics', 'vibrate' in navigator ? 'ok' : 'warn', 'vibrate' in navigator ? 'Supported' : 'Not on this phone: sound only');
  // Sound
  if (audio.ctx) {
    const ch = audio.outputChannels;
    setCheck('sound', ch >= 2 ? 'ok' : 'bad', ch >= 2 ? 'Stereo, ready' : 'Mono: directions will not work');
  } else {
    setCheck('sound', 'idle', 'Open Sound check to test');
  }
  // Camera permission (where the browser can tell us without asking)
  try {
    const p = await navigator.permissions?.query({ name: 'camera' as PermissionName });
    if (p) setCheck('camera', p.state === 'granted' ? 'ok' : p.state === 'denied' ? 'bad' : 'idle', p.state === 'granted' ? 'Allowed' : p.state === 'denied' ? 'Blocked: allow it in site settings' : 'Asks when you start');
  } catch {
    /* not supported (Safari/Firefox): leave as is */
  }
  // Model
  if (detector.model) setCheck('model', 'ok', `Ready on this device (${detector.backend})`);
  // Motion
  if (settings.mount === 'table') setCheck('motion', 'idle', 'Off for table demos');
  else if (motion.available) setCheck('motion', 'ok', 'On');
  else setCheck('motion', 'idle', 'Starts with EchoPath');
  // Battery
  await refreshBattery();
}

// ---------------------------------------------------------------------------
// Start flow: Start -> (first run: safety notice -> headphone check) -> camera -> running
// ---------------------------------------------------------------------------
$('btn-start').addEventListener('click', async () => {
  // Audio, speech and motion sensors can only start inside a tap on iOS.
  // The motion permission request must come first, before any await.
  if (settings.activity === 'track' || settings.mount !== 'table') void motion.start().then(() => refreshChecks());
  await audio.unlock().catch(() => {});
  announcer.unlock();
  void preloadModel().catch(() => {});
  if (settings.activity === 'walk' && (settings.depthCane || settings.echoEverySec > 0))
    void depthClient.load().catch((e) => console.warn('[EchoPath] depth unavailable:', e));
  if (!settings.disclaimerAccepted) {
    show('disclaimer');
    readDisclaimer();
    return;
  }
  await continueStart();
});

function readDisclaimer(): void {
  announcer.say($('disclaimer-text').innerText.replace(/\n+/g, ' '), { interrupt: true });
}

$('btn-reread').addEventListener('click', readDisclaimer);
$('btn-accept').addEventListener('click', async () => {
  announcer.cancel();
  update({ disclaimerAccepted: true });
  await continueStart();
});

async function continueStart(): Promise<void> {
  if (audio.outputChannels === 1) {
    // Spatial sound is physically impossible on a mono output: say so up front.
    audio.earcon('warning');
    announcer.say(MONO_HELP_SPOKEN, { interrupt: true });
  }
  if (!settings.headphoneCheckDone) await headphoneCheck();
  if (settings.activity === 'track') await startTrack();
  else await startRunning();
}

function preloadModel(): Promise<void> {
  if (!modelLoading || detector.model !== settings.model) {
    modelLoading = session.ensureModel().catch((e) => {
      modelLoading = null;
      throw e;
    });
  }
  return modelLoading;
}

async function startRunning(simSource?: FrameSource): Promise<void> {
  const usingFile = testVideo !== null && !simSource;
  status('Starting', usingFile ? 'Loading the test video.' : 'Your browser will ask to use the camera. Choose Allow.', {
    busy: true,
  });
  if (!usingFile && !simSource) announcer.say('Your browser will ask to use the camera. Choose Allow.');
  const source: FrameSource = simSource
    ? simSource
    : usingFile
    ? new FileSource(video, testVideo!)
    : new CameraSource(video, settings.cameraId, 30, settings.wideAngle);
  try {
    await source.start();
  } catch (e) {
    if (e instanceof CameraError && e.reason === 'notfound' && settings.cameraId) {
      update({ cameraId: '' }); // the chosen camera was unplugged: fall back to automatic
      return startRunning();
    }
    const err = e instanceof CameraError ? e : new CameraError(String(e), 'other');
    const msg = cameraHelp(err);
    status('Camera unavailable', msg, { retry: true });
    audio.earcon('warning');
    announcer.say(msg, { interrupt: true });
    return;
  }

  try {
    status('Starting', 'Loading the detection model.', { busy: true });
    await preloadModel();
  } catch (e) {
    source.stop();
    const msg = 'The detection model could not load. Check your connection for the first visit, then try again.';
    console.error(e);
    status('Model failed to load', msg, { retry: true });
    audio.earcon('warning');
    announcer.say(msg, { interrupt: true });
    return;
  }

  await wakeLock.acquire();
  if (classifyOutput(await outputLabel()) === 'speakers')
    announcer.say('Sound is playing through the laptop speakers, not headphones. Connect your headphones for direction.');
  setPaused(false);
  applyMountUi();
  show('running');
  await session.start(source);
  updateMirror();
  startMediaSession();
  audio.earcon('start');
  announcer.say(`EchoPath is running. ${gestureText(false)}`);
}

/** Flip left/right when the camera looks at the listener (see shouldMirror). */
function updateMirror(): void {
  const src = session.currentSource;
  const mirror = src ? shouldMirror(src.kind, src.facing, settings.cameraFacing) : false;
  session.mirror = mirror;
  video.style.transform = mirror ? 'scaleX(-1)' : '';
}

async function switchCamera(deviceId: string): Promise<void> {
  if (session.state === 'idle' || testVideo) return;
  const src = new CameraSource(video, deviceId, 30, settings.wideAngle);
  try {
    session.currentSource?.stop();
    await src.start();
    session.setSource(src);
    updateMirror();
    announcer.say(`Camera changed.`);
  } catch (e) {
    session.fail(e instanceof CameraError ? cameraHelp(e) : 'That camera could not start.');
  }
}

function cameraHelp(e: CameraError): string {
  switch (e.reason) {
    case 'denied':
      return 'Camera permission was denied. Open your browser settings for this site, allow the camera, then tap Try again.';
    case 'insecure':
      return 'The camera only works when this page is opened over https. Open the secure link and try again.';
    case 'notfound':
      return 'No camera was found on this device.';
    case 'busy':
      return 'Another app is using the camera. Close it, then tap Try again.';
    case 'unsupported':
      return 'This browser cannot use the camera. Try current Chrome on Android or Safari on iPhone.';
    default:
      return `The camera could not start. ${e.message}`;
  }
}

$('btn-retry').addEventListener('click', () => void (settings.activity === 'track' ? startTrack() : startRunning()));
$('btn-status-back').addEventListener('click', () => show('welcome'));

// ---------------------------------------------------------------------------
// Sound check: where sound is going, stereo or mono, direction test, palette
// ---------------------------------------------------------------------------
const MONO_HELP_SPOKEN =
  'Your headphones are playing in mono, so left and right cannot be heard. On a computer, choose the headphones entry marked stereo, not the headset or hands free entry, and close any call or meeting app using the headset microphone.';

async function outputLabel(): Promise<string> {
  try {
    const devs = await navigator.mediaDevices.enumerateDevices();
    const outs = devs.filter((d) => d.kind === 'audiooutput');
    const id = audio.outputId || 'default';
    const hit = outs.find((d) => d.deviceId === id) ?? outs.find((d) => d.deviceId === 'default');
    const label = hit?.label.replace(/^Default - /, '');
    return label || 'System default output';
  } catch {
    return 'System default output';
  }
}

/** Bigger audio buffers on Bluetooth stop crackle and dropouts (Settings -> Audio buffer). */
async function applyLatencyMode(kind: ReturnType<typeof classifyOutput>): Promise<void> {
  const mode =
    settings.latencyMode === 'auto' ? (kind === 'bt-stereo' || kind === 'bt-handsfree' ? 'balanced' : 'interactive') : settings.latencyMode;
  await audio.setLatencyMode(mode).catch(() => {});
}

async function refreshSound(): Promise<void> {
  await audio.unlock().catch(() => {});
  const label = await outputLabel();
  const ch = audio.outputChannels;
  const delay = audio.outputLatencyMs;
  const kind = classifyOutput(label);
  const handsFree = kind === 'bt-handsfree';
  const speakers = kind === 'speakers';
  setCheck('out-device', handsFree || speakers ? 'bad' : 'ok', label + (speakers ? ' (laptop speakers, not headphones)' : ''));
  await applyLatencyMode(kind);
  setCheck('out-stereo', ch >= 2 ? 'ok' : 'bad', ch >= 2 ? `Yes (${ch} channels)` : 'No, mono');
  setCheck(
    'out-delay',
    delay > 120 ? 'warn' : 'ok',
    delay > 0 ? `about ${Math.round(delay)} ms${delay > 120 ? ' (Bluetooth: cues arrive a bit late)' : ''}` : 'Not reported',
  );
  const problem = $('out-problem');
  if (speakers) {
    problem.hidden = false;
    problem.innerHTML =
      '<strong>Sound is going to the laptop speakers.</strong> Your Bluetooth headphones are not connected for audio. Open the fix steps below, connect them, then press Reconnect sound.';
  } else if (ch < 2 || handsFree) {
    problem.hidden = false;
    problem.innerHTML =
      '<strong>Left and right will not work on this output.</strong> ' +
      (handsFree
        ? 'This is the headset (hands-free) mode of your Bluetooth headphones, which is mono. '
        : 'The output is mono. ') +
      'On Windows: open Sound settings and choose the entry for your headphones marked <em>Headphones</em> or <em>Stereo</em>, not <em>Headset</em> or <em>Hands-Free</em>. Close calls or meeting apps using the headset microphone. Also check that Mono audio is off in accessibility settings. Then press Reconnect sound.';
  } else {
    problem.hidden = true;
  }
  void refreshChecks();
}

$('btn-sound').addEventListener('click', async () => {
  await audio.unlock().catch(() => {});
  show('sound');
});
$('btn-sound-back').addEventListener('click', () => show(session.state === 'idle' ? 'welcome' : 'running'));

$('btn-reconnect').addEventListener('click', async () => {
  await audio.rebuild();
  if (settings.audioOutputId) await audio.setOutput(settings.audioOutputId).catch(() => {});
  await refreshSound();
  audio.earcon('ok');
  announcer.say('Sound reconnected. Try the direction test.');
});

document.querySelector('#screen-sound .row3')!.addEventListener('click', async (e) => {
  const tone = (e.target as HTMLElement).closest<HTMLElement>('[data-tone]')?.dataset.tone;
  if (!tone) return;
  await audio.unlock().catch(() => {});
  if (tone === 'sweep') {
    announcer.showText('The sound circles all the way around you: ahead, right, behind, left.');
    await audio.spatialTest(4);
  } else {
    await audio.testTone(tone as 'left' | 'right');
  }
});

document.querySelector('#screen-sound .palette')!.addEventListener('click', async (e) => {
  const kind = (e.target as HTMLElement).closest<HTMLElement>('[data-preview]')?.dataset.preview;
  if (!kind) return;
  await audio.unlock().catch(() => {});
  if (kind === 'tick') {
    for (let i = 0; i < 3; i++) setTimeout(() => audio.earcon('tick'), i * 700);
    return;
  }
  const side = kind === 'guide' ? 'right' : 'center';
  await audio.preview(kind as 'person', side, kind === 'vehicle' ? 0.8 : 0.4);
});

$('btn-hp-guided').addEventListener('click', async () => {
  await headphoneCheck();
  show('sound');
});

// ---------------------------------------------------------------------------
// Guided headphone check (US-3.5)
// ---------------------------------------------------------------------------
let hpResolve: ((ok: boolean) => void) | null = null;
let hpSide: 'left' | 'right' = 'left';
const hpAnswers: Record<'left' | 'right', string> = { left: '', right: '' };

function headphoneCheck(): Promise<boolean> {
  $('hp-question').hidden = true;
  $('hp-begin').hidden = false;
  $('hp-instructions').textContent = 'Put on your headphones. You will hear a tone in one ear, then in the other.';
  show('headphones');
  announcer.say('Headphone check. Put on your headphones, then tap Play the first tone.');
  return new Promise((r) => (hpResolve = r));
}

async function playSide(side: 'left' | 'right'): Promise<void> {
  hpSide = side;
  $('hp-begin').hidden = true;
  $('hp-question').hidden = true;
  await audio.unlock().catch(() => {});
  await audio.testTone(side);
  $('hp-question').hidden = false;
  $('hp-prompt').textContent = 'Where did you hear the tone?';
  ($('hp-question').querySelector('button') as HTMLButtonElement).focus();
  announcer.say('Where did you hear the tone?');
}

$('hp-begin').addEventListener('click', () => void playSide('left'));
$('hp-replay').addEventListener('click', () => void playSide(hpSide));
$('hp-question').addEventListener('click', (e) => {
  const heard = (e.target as HTMLElement).closest<HTMLElement>('[data-heard]')?.dataset.heard;
  if (!heard) return;
  hpAnswers[hpSide] = heard;
  if (hpSide === 'left') {
    void playSide('right');
    return;
  }
  finishHeadphoneCheck();
});
$('hp-skip').addEventListener('click', () => {
  announcer.cancel();
  hpResolve?.(true);
  hpResolve = null;
});

function finishHeadphoneCheck(): void {
  const { left, right } = hpAnswers;
  let msg: string;
  if (left === 'left' && right === 'right') {
    msg = 'Stereo works. Left and right cues will be clear.';
    update({ headphoneCheckDone: true });
    audio.earcon('ok');
  } else if (left === 'both' || right === 'both') {
    msg =
      'You heard the tones equally in both ears. You may be using the phone speaker, a headset in hands-free mode, or mono audio. Direction cues will not work until stereo works. Open Sound check for help.';
    audio.earcon('warning');
  } else if (left === 'right' && right === 'left') {
    msg = 'Left and right seem swapped. Check that your earbuds are in the correct ears.';
    audio.earcon('warning');
  } else {
    msg = 'The tones were not heard on the expected sides. Check your headphones and try again from Sound check.';
    audio.earcon('warning');
  }
  $('hp-instructions').textContent = msg;
  announcer.say(msg, { interrupt: true });
  $('hp-question').hidden = true;
  const r = hpResolve;
  hpResolve = null;
  // Give the message time to be read before moving on.
  setTimeout(() => {
    if (r) r(true);
    else show(session.state === 'idle' ? 'welcome' : 'running');
  }, 2500);
}

// ---------------------------------------------------------------------------
// Running: gestures, controls, radar and status chips
// ---------------------------------------------------------------------------
const pauseTarget = $('pause-target');
const HOLD_MS = 700;

function gestureText(paused: boolean): string {
  const worn = isWorn(settings.mount);
  if (paused) return worn ? 'Press and hold anywhere to resume.' : 'Double-tap to resume.';
  return worn
    ? 'Press and hold anywhere to pause. Double-tap to hear what is around you.'
    : 'Double-tap to pause. Press and hold to hear what is around you.';
}

function applyMountUi(): void {
  $('screen-running').classList.toggle('worn', isWorn(settings.mount));
  $('gesture-hint').textContent = gestureText(session.state === 'paused');
}

/** Worn: hold = pause, double-tap = describe. Hand/table: double-tap = pause, hold = describe. */
function onHold(): void {
  if (isWorn(settings.mount)) togglePause();
  else describe();
}
function onDoubleTap(): void {
  if (isWorn(settings.mount)) describe();
  else togglePause();
}

/**
 * Full-screen gestures that survive being worn: press-and-hold (0.7 s) and
 * double-tap. A click with no pointer gesture (VoiceOver/TalkBack activation
 * or keyboard) counts as a deliberate pause toggle.
 */
function attachGestures(el: HTMLElement, onHoldFn: () => void, onDoubleFn: () => void, onActivate: () => void): void {
  let lastTap = 0, lastPointer = 0, held = false;
  let timer: number | undefined;
  el.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    held = false;
    clearTimeout(timer);
    timer = window.setTimeout(() => {
      held = true;
      navigator.vibrate?.(40);
      onHoldFn();
    }, HOLD_MS);
  });
  const cancel = () => clearTimeout(timer);
  el.addEventListener('pointercancel', cancel);
  el.addEventListener('pointerleave', cancel);
  el.addEventListener('pointerup', () => {
    clearTimeout(timer);
    lastPointer = performance.now();
    if (held) return;
    if (lastPointer - lastTap < 400) {
      lastTap = 0;
      onDoubleFn();
    } else {
      lastTap = lastPointer;
    }
  });
  el.addEventListener('contextmenu', (e) => e.preventDefault());
  el.addEventListener('click', () => {
    if (performance.now() - lastPointer > 600) onActivate();
  });
}

attachGestures(pauseTarget, () => onHold(), () => onDoubleTap(), () => togglePause());

$('btn-pause').addEventListener('click', () => togglePause());
$('btn-describe').addEventListener('click', () => describe());

function describe(): void {
  if (session.state === 'idle') return;
  const text = session.describe();
  if (announcer.supported) announcer.say(text, { interrupt: true, system: false, priority: 0 });
  else announcer.showText(text, true);
}

function togglePause(): void {
  if (session.state === 'running') {
    session.pause();
    setPaused(true);
    audio.earcon('pause');
    announcer.say(`Paused. ${gestureText(true)}`);
  } else if (session.state === 'paused') {
    session.resume();
    setPaused(false);
    audio.earcon('resume');
    announcer.say('Resumed.');
  }
}

function setPaused(p: boolean): void {
  $('screen-running').classList.toggle('paused', p);
  $('btn-pause').textContent = p ? 'Resume' : 'Pause';
  $('pause-label').textContent = p ? `EchoPath is paused. ${gestureText(true)}` : `EchoPath is running. ${gestureText(false)}`;
  $('gesture-hint').textContent = gestureText(p);
  setChip('chip-state', p ? 'warn' : 'ok', p ? 'Paused' : 'Running');
  if ('mediaSession' in navigator) navigator.mediaSession.playbackState = p ? 'paused' : 'playing';
  if (p) clearOverlay(overlay);
}

$('btn-stop').addEventListener('click', () => {
  session.stop();
  stopWalkSimulator();
  wakeLock.release();
  stopMediaSession();
  clearOverlay(overlay);
  lastReport = null;
  audio.earcon('stop');
  announcer.say('EchoPath stopped.');
  returnHome();
});

let lastWsimText = 0;

/** Practice / demo: the real WALK pipeline on a simulated park path with poles, bins and people. */
async function startWalkSimulator(): Promise<void> {
  await audio.unlock().catch(() => {});
  announcer.unlock();
  motion.stop(); // the simulator provides motion
  wsim = new WalkSimulator(motion);
  simOverrides = { mount: 'chest', cameraFacing: 'same', fovDeg: 65, depthCane: true };
  session.applySettings(eff());
  void depthClient.load().catch((e) => console.warn('[EchoPath] depth unavailable:', e));
  $('wsim-view').prepend(wsim.canvas);
  $('wsim-panel').hidden = false;
  $('screen-running').classList.add('simulating');
  await startRunning(wsim.source());
  if (wsim) wsim.frozen = session.state !== 'running';
  announcer.showText('Walk simulator running. The autopilot walker is blind: it only stops or steps aside when EchoPath tells it to.');
}

function stopWalkSimulator(): void {
  if (!wsim) return;
  wsim.stop();
  wsim.canvas.remove();
  wsim = null;
  simOverrides = null;
  session.applySettings(settings);
  $('wsim-panel').hidden = true;
  $('screen-running').classList.remove('simulating');
  if (settings.mount !== 'table') void motion.start();
}

type Scene = 'walk' | 'stadium' | 'road' | 'purple' | 'pg-photo' | 'video-walk' | 'video-run';

/** One dropdown for every practice scene: simulations and real footage. */
async function startScene(scene: Scene): Promise<void> {
  if (scene === 'walk') return startWalkSimulator();
  if (scene === 'stadium' || scene === 'road' || scene === 'purple') return startSimulator(scene);
  if (scene === 'pg-photo') return startRealPhoto();
  // Real video: pick the file, then run it through the walk or track pipeline.
  const input = $<HTMLInputElement>('practice-file');
  input.value = '';
  input.onchange = () => {
    const f = input.files?.[0];
    if (!f) return;
    testVideo = f;
    if (scene === 'video-walk') void startRunning();
    else void startTrack();
  };
  input.click();
}

$('btn-practice').addEventListener('click', () => void startScene($<HTMLSelectElement>('practice-scene').value as Scene));
$<HTMLSelectElement>('wsim-scene').addEventListener('change', (e) => {
  const v = (e.target as HTMLSelectElement).value as Scene;
  if (v === 'walk' || !wsim) return;
  $('btn-stop').click();
  void startSimulator(v as 'stadium' | 'road' | 'purple');
});

/** Google's real-world truth for the Project Guideline photo: which pixels are the line. */
let golden: { w: number; h: number; on: Uint8Array } | null = null;
let realPhoto = false;

async function loadGolden(): Promise<void> {
  const img = new Image();
  img.src = `${BASE}samples/pg/guideline1_mask_golden.png`;
  await img.decode();
  const c = document.createElement('canvas');
  c.width = img.naturalWidth;
  c.height = img.naturalHeight;
  const g = c.getContext('2d', { willReadFrequently: true })!;
  g.drawImage(img, 0, 0);
  const px = g.getImageData(0, 0, c.width, c.height).data;
  const on = new Uint8Array(c.width * c.height);
  for (let i = 0; i < on.length; i++) on[i] = px[i * 4] + px[i * 4 + 1] + px[i * 4 + 2] > 300 ? 1 : 0;
  golden = { w: c.width, h: c.height, on };
}

/**
 * Score Google's model output (keypoints) against Google's own hand-labelled
 * line: how many keypoints land on the real line, how much of the line is
 * found, and the mean horizontal miss in pixels.
 */
function goldenScore(kps: { x: number; y: number }[]): { precision: number; recall: number; errPx: number } | null {
  if (!golden || !kps.length) return null;
  const { w, h, on } = golden;
  const centre = (y: number) => {
    let s = 0, n = 0;
    for (let x = 0; x < w; x++) if (on[y * w + x]) (s += x), n++;
    return n ? s / n : null;
  };
  let hit = 0, err = 0, errN = 0;
  for (const k of kps) {
    const y = Math.min(h - 1, Math.round(k.y * h)), c = centre(y);
    if (c === null) continue;
    const d = Math.abs(k.x * w - c);
    if (d < 12) hit++;
    err += d;
    errN++;
  }
  const bands = 12;
  let lineBands = 0, found = 0;
  for (let b = 0; b < bands; b++) {
    const y0 = Math.floor((b * h) / bands), y1 = Math.floor(((b + 1) * h) / bands);
    let has = false;
    for (let y = y0; y < y1 && !has; y += 2) has = centre(y) !== null;
    if (!has) continue;
    lineBands++;
    if (kps.some((k) => k.y * h >= y0 && k.y * h < y1)) found++;
  }
  return { precision: hit / kps.length, recall: lineBands ? found / lineBands : 0, errPx: errN ? err / errN : 0 };
}

/** Real-world check: Google's real photo through the real track pipeline and Google's model. */
async function startRealPhoto(): Promise<void> {
  await audio.unlock().catch(() => {});
  announcer.unlock();
  realPhoto = true;
  simOverrides = { trackCourse: 'line', lineColor: 'purple', mountHeight: 1.0, cameraFacing: 'same', trackCountdown: false };
  void loadGolden().catch((e) => console.warn('[EchoPath] golden mask:', e));
  $('sim-panel').classList.add('real');
  await startTrack(new ImageSource(tvideo, `${BASE}samples/pg/guideline1.png`), true);
  announcer.showText("Real-world check: Google Project Guideline's own test photo, a real path with their purple line and fallen leaves. Scored against Google's hand-labelled line.");
}
for (const [id, key] of [
  ['wsim-left', 'left'],
  ['wsim-right', 'right'],
] as const) {
  const el = $(id);
  const set = (v: boolean) => () => wsim && (wsim.input[key] = v);
  el.addEventListener('pointerdown', set(true));
  el.addEventListener('pointerup', set(false));
  el.addEventListener('pointerleave', set(false));
  el.addEventListener('pointercancel', set(false));
}
$('wsim-auto').addEventListener('click', (e) => {
  if (!wsim) return;
  wsim.autopilot = !wsim.autopilot;
  const b = e.currentTarget as HTMLButtonElement;
  b.setAttribute('aria-pressed', String(wsim.autopilot));
  b.textContent = `Autopilot: ${wsim.autopilot ? 'on' : 'off'}`;
});

function setChip(id: string, state: CheckState, text: string): void {
  const el = $(id);
  el.dataset.state = state;
  el.querySelector('.txt')!.textContent = text;
}

let lastChipUpdate = 0;
session.onFrame = (r) => {
  lastReport = r;
  if (wsim) {
    wsim.guidance = { blocked: r.policy.blocked, side: r.policy.guideSide, noWay: r.policy.noWayAround, caneM: r.depth?.center && r.depth.center.z < 2.5 ? r.depth.center.z : null };
    drawOverlay($<HTMLCanvasElement>('wsim-overlay'), wsim.video, r, settings.centerWidth, settings.corridorWidth);
    if (performance.now() - lastWsimText > 300) {
      lastWsimText = performance.now();
      const t = wsim.aheadTruth(), sc = wsim.score;
      const heard = r.policy.blocked
        ? r.policy.noWayAround || !r.policy.guideSide ? 'STOP' : `step ${r.policy.guideSide}`
        : r.depth?.center && r.depth.center.z < 2.5 ? `cane: ${r.depth.center.z.toFixed(1)} m` : 'clear';
      const bump = wsim.lastBump && performance.now() - wsim.lastBump.at < 2500 ? ` · BUMPED: ${wsim.lastBump.what}` : '';
      $('wsim-truth').textContent =
        `Truth: ${t ? `${t.what} ${t.distance.toFixed(1)} m${Math.abs(t.side) > 0.15 ? (t.side > 0 ? ' right' : ' left') : ' ahead'}` : 'path clear'} · EchoPath: ${heard}${bump}
` +
        `${Math.round(sc.metres)} m · in the way ${sc.inWay}, avoided ${sc.cleared} · bumps ${sc.bumps} (head ${sc.headBumps}) · helped ${sc.assists}`;
    }
  }
  if (settings.debugOverlay) drawOverlay(overlay, video, r, settings.centerWidth, settings.corridorWidth);
  const now = performance.now();
  if (now - lastChipUpdate > 300) {
    lastChipUpdate = now;
    updateChips(r);
  }
  if (dialog.open) renderStats(r.stats);
};

function updateChips(r: FrameReport): void {
  const ch = audio.outputChannels;
  const delay = audio.outputLatencyMs;
  setChip(
    'chip-audio',
    ch < 2 ? 'bad' : delay > 120 ? 'warn' : 'ok',
    ch < 2 ? 'Mono: no direction' : `${settings.mode === 'spatial' ? 'Spatial' : 'Stereo'}${delay > 120 ? ' · Bluetooth delay' : ''}`,
  );
  const m = r.motion;
  if (!m) setChip('chip-motion', 'idle', settings.mount === 'table' ? 'Table mode' : 'No motion sensor');
  else setChip('chip-motion', m.walking ? 'ok' : 'idle', m.walking ? `Walking ${m.speed.toFixed(1)} m/s` : 'Standing');
  const fps = r.stats.fps;
  setChip('chip-perf', fps >= 12 ? 'ok' : fps >= 6 ? 'warn' : 'bad', `${fps.toFixed(0)} fps`);
  const banner = $('banner');
  const msg = r.policy.blocked
    ? r.policy.noWayAround
      ? 'Path blocked: no clear way around'
      : `Path blocked${r.policy.guideSide ? `: step ${r.policy.guideSide}${r.policy.guideFrom === 'path' ? ' (stays on path)' : ''}` : ''}`
    : r.policy.unexplainedLooming
      ? `Something approaching from the ${r.policy.unexplainedLooming}`
    : r.quality === 'dark'
      ? 'Too dark to see well'
      : r.quality === 'blurry'
        ? 'Camera view blurry or covered'
        : '';
  banner.hidden = !msg;
  banner.textContent = msg;
}

function radarLoop(now: number): void {
  if (current !== 'running') return;
  drawRadar(radar, session.state === 'idle' ? null : lastReport, settings.fovDeg, now);
  requestAnimationFrame(radarLoop);
}

function renderStats(st: FrameReport['stats']): void {
  const f = (n: number) => (Number.isFinite(n) ? n.toFixed(0) : '–');
  $('stats').textContent =
    `${st.fps.toFixed(1)} frames per second, inference ${f(st.inferenceP50)} ms\n` +
    `Capture to sound p95: ${f(st.latencyP95)} ms (median ${f(st.latencyP50)} ms)\n` +
    `${MODELS[st.model as keyof typeof MODELS]?.title ?? st.model}, ${st.inputWidth}px, ${st.backend} in ${st.where}\n` +
    `Audio output: ${audio.outputChannels} channel(s), delay ${f(audio.outputLatencyMs)} ms${session.mirror ? ', camera mirrored' : ''}`;
}

// ---------------------------------------------------------------------------
// Track run: lane guidance + live run stats (KineticSpatial)
// ---------------------------------------------------------------------------
const SIM_OVERRIDES: Record<'stadium' | 'road' | 'purple', Partial<Settings>> = {
  stadium: { trackCourse: 'lanes', lineColor: 'white', mountHeight: 1.3, cameraFacing: 'same' },
  road: { trackCourse: 'line', lineColor: 'yellow', mountHeight: 1.3, cameraFacing: 'same' },
  purple: { trackCourse: 'line', lineColor: 'purple', mountHeight: 1.3, cameraFacing: 'same' },
};

/** Practice / demo: the real track pipeline driven by the built-in simulator. */
async function startSimulator(pick?: 'stadium' | 'road' | 'purple'): Promise<void> {
  await audio.unlock().catch(() => {});
  announcer.unlock();
  const course = pick ?? (settings.trackCourse === 'lanes' ? 'stadium' : settings.lineColor === 'purple' ? 'purple' : 'road');
  motion.stop(); // the simulator provides motion; ignore the real phone's sensors meanwhile
  sim = new TrackSimulator(course, motion);
  simOverrides = SIM_OVERRIDES[course];
  $<HTMLSelectElement>('sim-course').value = course;
  $('sim-view').prepend(sim.canvas);
  $('sim-panel').hidden = false;
  $('screen-track').classList.add('simulating');
  await startTrack(sim.source());
  announcer.showText('Simulator running. The autopilot runner only hears EchoPath. Use Left and Right, or the arrow keys, to drift on purpose.');
}

function stopSimulator(): void {
  if (!sim) return;
  sim.stop();
  sim.canvas.remove();
  sim = null;
  simOverrides = null;
  $('sim-panel').hidden = true;
  $('screen-track').classList.remove('simulating');
  if (settings.mount !== 'table') void motion.start();
}

for (const [id, key] of [
  ['sim-left', 'left'],
  ['sim-right', 'right'],
] as const) {
  const el = $(id);
  const set = (v: boolean) => () => sim && (sim.input[key] = v);
  el.addEventListener('pointerdown', set(true));
  el.addEventListener('pointerup', set(false));
  el.addEventListener('pointerleave', set(false));
  el.addEventListener('pointercancel', set(false));
}
document.addEventListener('keydown', (e) => {
  if (!sim) return;
  if (e.key === 'ArrowLeft') sim.input.left = true;
  if (e.key === 'ArrowRight') sim.input.right = true;
});
document.addEventListener('keyup', (e) => {
  if (!sim) return;
  if (e.key === 'ArrowLeft') sim.input.left = false;
  if (e.key === 'ArrowRight') sim.input.right = false;
});
$('sim-auto').addEventListener('click', (e) => {
  if (!sim) return;
  sim.autopilot = !sim.autopilot;
  const b = e.currentTarget as HTMLButtonElement;
  b.setAttribute('aria-pressed', String(sim.autopilot));
  b.textContent = `Autopilot: ${sim.autopilot ? 'on' : 'off'}`;
});
$<HTMLSelectElement>('sim-course').addEventListener('change', (e) => {
  if (!sim) return;
  if ((e.target as HTMLSelectElement).value === 'walk') {
    stopTrack();
    void startWalkSimulator();
    return;
  }
  const c = (e.target as HTMLSelectElement).value as 'stadium' | 'road' | 'purple';
  sim.setCourse(c);
  simOverrides = SIM_OVERRIDES[c];
  if (c === 'purple') void pgSeg.load().catch(() => {});
  announcer.say(c === 'road' ? 'Road with a yellow guide line.' : 'Four hundred metre track, lane three.');
});
$('sim-slower').addEventListener('click', () => sim && (sim.runner.speed = Math.max(1.5, sim.runner.speed - 0.5)));
$('sim-faster').addEventListener('click', () => sim && (sim.runner.speed = Math.min(7, sim.runner.speed + 0.5)));

/** Truth vs estimate, for the simulator readout. */
const simScore: { t: number; truth: number; est: number | null }[] = [];

async function startTrack(simSource?: FrameSource, realWorld = false): Promise<void> {
  const usingFile = testVideo !== null && !simSource;
  status('Starting track mode', usingFile ? 'Loading the test video.' : 'Your browser will ask for the camera and your location. Choose Allow for both.', { busy: true });
  if (!usingFile) announcer.say('Your browser will ask for the camera and your location. Choose Allow for both.');
  const source: FrameSource =
    simSource ?? (usingFile ? new FileSource(tvideo, testVideo!) : new CameraSource(tvideo, settings.cameraId, 60));
  try {
    await source.start();
  } catch (e) {
    const err = e instanceof CameraError ? e : new CameraError(String(e), 'other');
    const msg = cameraHelp(err);
    status('Camera unavailable', msg, { retry: true });
    audio.earcon('warning');
    announcer.say(msg, { interrupt: true });
    return;
  }
  track.pgSeg = pgSeg;
  if (eff().lineColor === 'purple' && eff().trackCourse !== 'lanes') void pgSeg.load().catch((e) => console.warn('[EchoPath] PG model:', e));
  // Google Project Guideline's sound pack (falls back to the glide tone if it can't decode).
  if (settings.trackStyle === 'pg') await audio.loadPgSounds(BASE).catch(() => false);
  // The object model only powers "runner ahead"; lane guidance never waits for it.
  if (settings.trackObstacles && trackDetector.model !== 'efficientdet_lite0')
    void trackDetector.load('efficientdet_lite0').catch(() => {});
  await wakeLock.acquire();
  setTrackPaused(false);
  $('screen-track').classList.add('worn');
  show('track');
  // Running: the camera faces the way you run. Only mirror if explicitly set to face you.
  track.mirror = !simSource && source.kind === 'camera' && settings.cameraFacing === 'toward';
  // Live view: the real camera, large, with what EchoPath sees drawn on it.
  if ((!simSource && settings.debugOverlay) || realWorld) {
    $('sim-view').prepend(tvideo);
    $('sim-panel').classList.add('live');
    $('sim-panel').hidden = false;
  }
  tvideo.style.transform = track.mirror ? 'scaleX(-1)' : '';
  startMediaSession();
  const intro =
    settings.trackStyle === 'tone'
      ? 'A quiet steady tone means you are on line. If it moves to one side and gets harsher, you are drifting toward that line.'
      : settings.trackStyle === 'guideline'
        ? 'Silence means you are on line. Beeps in one ear tell you to steer that way. A high warning means you are at the edge. Stop means stop.'
        : 'Silence means you are centred. A ping from one side means you are drifting toward that line. Stop means stop.';
  if (settings.trackCountdown) {
    announcer.say(`Track mode. ${intro} Ready.`, { interrupt: true });
    await new Promise((r) => setTimeout(r, Math.min(9000, 1200 + intro.length * 55)));
    for (const n of ['3', '2', '1']) {
      audio.earcon('ok');
      announcer.say(n, { system: false, priority: 0, interrupt: true });
      await new Promise((r) => setTimeout(r, 1000));
    }
    announcer.say('Go.', { system: false, priority: 0, interrupt: true });
    audio.earcon('start');
    track.start(source);
    if (sim) sim.frozen = false;
  } else {
    track.start(source);
    if (sim) sim.frozen = false;
    audio.earcon('start');
    announcer.say(`Track mode. ${intro} Press and hold to pause, double-tap for your stats.`);
  }
}

function setTrackPaused(p: boolean): void {
  $('screen-track').classList.toggle('paused', p);
  $('btn-tpause').textContent = p ? 'Resume' : 'Pause';
  $('track-hint').textContent = p ? 'Press and hold anywhere to resume.' : 'Press and hold anywhere to pause. Double-tap to hear your stats.';
  $('track-label').textContent = p ? 'Track guidance paused. Activate to resume.' : 'Track guidance running. Activate to pause.';
  setChip('tchip-state', p ? 'warn' : 'ok', p ? 'Paused' : 'Running');
  if ('mediaSession' in navigator) navigator.mediaSession.playbackState = p ? 'paused' : 'playing';
}

function toggleTrackPause(): void {
  if (track.state === 'running') {
    track.pause();
    if (sim) sim.frozen = true;
    setTrackPaused(true);
    audio.earcon('pause');
    announcer.say('Paused. Press and hold to resume.');
  } else if (track.state === 'paused') {
    track.resume();
    if (sim) sim.frozen = false;
    setTrackPaused(false);
    audio.earcon('resume');
    announcer.say('Resumed.');
  }
}

function sayStats(): void {
  if (track.state === 'idle') return;
  announcer.say(track.describe(), { interrupt: true, system: false, priority: 0 });
}

function stopTrack(): void {
  track.stop();
  stopSimulator();
  if (realPhoto) {
    realPhoto = false;
    simOverrides = null;
    $('sim-panel').classList.remove('real');
  }
  if ($('sim-panel').classList.contains('live')) {
    $('tpip').prepend(tvideo);
    $('sim-panel').classList.remove('live');
    $('sim-panel').hidden = true;
  }
  wakeLock.release();
  stopMediaSession();
  audio.earcon('stop');
  announcer.say(track.finish(), { interrupt: true });
  returnHome();
}

attachGestures($('track-target'), () => toggleTrackPause(), () => sayStats(), () => toggleTrackPause());
$('btn-tpause').addEventListener('click', () => toggleTrackPause());
$('btn-tstats').addEventListener('click', () => sayStats());
$('btn-tstop').addEventListener('click', () => stopTrack());
$('btn-tsettings').addEventListener('click', () => openSettings());

let lastTrackUi = 0;
track.onFrame = (r: TrackReport) => {
  const eff = simOverrides ? { ...settings, ...simOverrides } : settings;
  drawLaneGauge($<HTMLCanvasElement>('lane-gauge'), r, 0.61, eff.trackCourse);
  if (sim) {
    sim.guidance = r.guide;
    sim.halted = r.stopped;
    drawLaneOverlay($<HTMLCanvasElement>('sim-overlay'), sim.canvas, r, sim.camera());
    simScore.push({ t: performance.now(), truth: sim.lateral, est: r.world ? r.world.lateral : null });
    while (simScore.length && performance.now() - simScore[0].t > 60000) simScore.shift();
  } else if ($('sim-panel').classList.contains('live')) {
    drawLaneOverlay($<HTMLCanvasElement>('sim-overlay'), tvideo, r);
    if (realPhoto) {
      const sc = goldenScore(pgSeg.latest?.keypoints ?? []);
      $('sim-truth').textContent = sc
        ? `Google's model vs Google's hand labels: ${Math.round(sc.precision * 100)}% of points on the real line, ${Math.round(sc.recall * 100)}% of the line found, mean miss ${sc.errPx.toFixed(1)} px\nEchoPath: ${r.world ? `${Math.abs(r.world.lateral).toFixed(2)} m ${r.world.lateral > 0 ? 'right of' : 'left of'} the line` : 'line not locked'} · ${r.guide.magnitude > 0.05 ? `steer ${r.guide.steer > 0 ? 'right' : 'left'}` : 'on line'}`
        : "Running Google's model on the real photo...";
    }
  } else if (settings.debugOverlay) {
    drawLaneOverlay($<HTMLCanvasElement>('toverlay'), tvideo, r);
  }
  const now = performance.now();
  if (now - lastTrackUi < 250) return;
  lastTrackUi = now;
  const run = r.run;
  $('m-time').textContent = formatDuration(run.elapsedS);
  $('m-dist').textContent = run.distanceM >= 1000 ? `${(run.distanceM / 1000).toFixed(2)} km` : `${Math.round(run.distanceM)} m`;
  $('m-pace').textContent = formatPace(run.paceS);
  $('m-cad').textContent = run.cadence ? String(Math.round(run.cadence)) : '–';
  $('m-hr').textContent = run.heartRate ? String(run.heartRate) : '–';
  $('m-laps').textContent = String(run.laps);
  setChip(
    'tchip-lane',
    r.stopped || r.lost ? 'bad' : r.level === 'centred' ? 'ok' : 'warn',
    r.stopped ? 'STOP' : r.lost ? 'No line' : r.level === 'centred' ? (r.bend ? `On line, bend ${r.bend}` : 'On line') : 'Drifting',
  );
  const gps = runTracker.gpsState;
  setChip('tchip-gps', gps === 'ok' ? 'ok' : gps === 'waiting' ? 'warn' : 'idle', gps === 'ok' ? 'GPS' : gps === 'waiting' ? 'GPS searching' : 'Step distance');
  setChip('tchip-hr', run.heartRate ? 'ok' : 'idle', run.heartRate ? `${run.heartRate} bpm` : 'No HR');
  setChip('tchip-perf', r.fps >= 24 ? 'ok' : r.fps >= 12 ? 'warn' : 'bad', `${r.fps.toFixed(0)} fps`);
  if (sim) {
    const withEst = simScore.filter((s) => s.est !== null);
    const rms = withEst.length ? Math.sqrt(withEst.reduce((a, s) => a + (s.truth - s.est!) ** 2, 0) / withEst.length) : NaN;
    const inLane = simScore.filter((s) => Math.abs(s.truth) < (eff.trackCourse === 'lanes' ? 0.61 : 0.5)).length / Math.max(1, simScore.length);
    $('sim-truth').textContent =
      `Truth: ${Math.abs(sim.lateral).toFixed(2)} m ${sim.lateral > 0 ? 'right' : 'left'} · EchoPath: ${r.world ? `${Math.abs(r.world.lateral).toFixed(2)} m ${r.world.lateral > 0 ? 'right' : 'left'}` : '–'}\n` +
      `Estimate error (RMS, last min): ${Number.isFinite(rms) ? rms.toFixed(2) + ' m' : '–'} · In lane: ${(inLane * 100).toFixed(0)}% · ${sim.runner.speed.toFixed(1)} m/s · ${Math.round(sim.runner.distance)} m`;
  }
};

// ---------------------------------------------------------------------------
// Headphone buttons (Media Session): play/pause toggles, next = describe
// ---------------------------------------------------------------------------
let mediaEl: HTMLAudioElement | null = null;

function silentWav(seconds = 2, rate = 8000): string {
  const n = seconds * rate;
  const buf = new ArrayBuffer(44 + n);
  const v = new DataView(buf);
  const w = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  w(0, 'RIFF');
  v.setUint32(4, 36 + n, true);
  w(8, 'WAVEfmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, rate, true);
  v.setUint32(28, rate, true);
  v.setUint16(32, 1, true);
  v.setUint16(34, 8, true);
  w(36, 'data');
  v.setUint32(40, n, true);
  new Uint8Array(buf, 44).fill(128); // 8-bit silence
  return URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
}

/**
 * Best-effort: a silent looping media element makes the browser treat
 * EchoPath as "playing", so Bluetooth headphone buttons reach us.
 */
function startMediaSession(): void {
  if (!('mediaSession' in navigator)) return;
  try {
    mediaEl ??= Object.assign(new Audio(silentWav()), { loop: true });
    void mediaEl.play().catch(() => {});
    navigator.mediaSession.metadata = new MediaMetadata({ title: 'EchoPath', artist: 'Audio navigation' });
    navigator.mediaSession.setActionHandler('play', () => (track.state === 'paused' ? toggleTrackPause() : session.state === 'paused' && togglePause()));
    navigator.mediaSession.setActionHandler('pause', () => (track.state === 'running' ? toggleTrackPause() : session.state === 'running' && togglePause()));
    navigator.mediaSession.setActionHandler('nexttrack', () => (track.state !== 'idle' ? sayStats() : describe()));
    navigator.mediaSession.setActionHandler('previoustrack', () => (track.state !== 'idle' ? sayStats() : describe()));
    navigator.mediaSession.playbackState = 'playing';
  } catch {
    /* handlers unsupported */
  }
}

function stopMediaSession(): void {
  mediaEl?.pause();
  if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'none';
}

// ---------------------------------------------------------------------------
// Battery: a dead phone mid-walk means silent guidance, so warn early
// ---------------------------------------------------------------------------
type BatteryLike = { level: number; charging: boolean; addEventListener(t: string, f: () => void): void };
let battery: BatteryLike | null = null;
const batteryWarned = new Set<number>();

async function refreshBattery(): Promise<void> {
  const nav = navigator as Navigator & { getBattery?: () => Promise<BatteryLike> };
  if (!battery && nav.getBattery) {
    battery = await nav.getBattery().catch(() => null);
    battery?.addEventListener('levelchange', onBattery);
    battery?.addEventListener('chargingchange', onBattery);
  }
  onBattery();
}

function onBattery(): void {
  if (!battery) {
    setCheck('battery', 'idle', 'Not reported by this browser');
    return;
  }
  const pct = Math.round(battery.level * 100);
  const state: CheckState = battery.charging || pct > 30 ? 'ok' : pct > 15 ? 'warn' : 'bad';
  const text = `${pct}%${battery.charging ? ', charging' : ''}`;
  setCheck('battery', state, text);
  const chip = $('chip-battery');
  chip.hidden = false;
  setChip('chip-battery', state, `Battery ${text}`);
  if ((session.state !== 'idle' || track.state !== 'idle') && !battery.charging) {
    for (const lvl of [20, 10]) {
      if (pct <= lvl && !batteryWarned.has(lvl)) {
        batteryWarned.add(lvl);
        audio.earcon('attention');
        announcer.say(`Battery is at ${pct} percent.`);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Devices: Bluetooth headphones connecting / disconnecting
// ---------------------------------------------------------------------------
let deviceTimer: number | undefined;
navigator.mediaDevices?.addEventListener?.('devicechange', () => {
  clearTimeout(deviceTimer);
  // Let the OS finish switching its default output first.
  deviceTimer = window.setTimeout(async () => {
    if (audio.ctx) {
      if (settings.audioOutputId) await audio.setOutput(settings.audioOutputId).catch(() => audio.setOutput(''));
      else await audio.rebuild().catch(() => {}); // follow the new default (e.g. headphones just connected)
    }
    if (dialog.open) void refreshDevices();
    if (current === 'sound') void refreshSound();
    if (session.state === 'idle' && track.state === 'idle') return;
    audio.earcon('attention');
    const mono = audio.outputChannels === 1;
    announcer.say(mono ? MONO_HELP_SPOKEN : `Sound output changed to ${await outputLabel()}.`);
  }, 800);
});

// Backgrounding pauses the camera in mobile browsers: warn, and recover on return (US-1.3).
document.addEventListener('visibilitychange', async () => {
  const active = session.state !== 'idle' ? session : track.state !== 'idle' ? track : null;
  if (!active) return;
  if (document.hidden) {
    audio.earcon('warning');
    announcer.say('EchoPath is in the background. Guidance is paused.', { interrupt: true });
    return;
  }
  await wakeLock.reacquire();
  await audio.unlock().catch(() => {});
  const src = active.currentSource;
  if (src instanceof CameraSource && !src.active) {
    try {
      await src.start();
    } catch {
      active.fail('The camera could not restart. Tap Stop, then Start.');
      return;
    }
  }
  if (active.state === 'running') announcer.say('EchoPath is back and running.');
});

// ---------------------------------------------------------------------------
// Settings (US-5.4): persisted on device, fully labelled for screen readers
// ---------------------------------------------------------------------------
function openSettings(): void {
  fillForm();
  void refreshDevices();
  dialog.showModal();
  $('settings-title').focus();
}
$('btn-settings-welcome').addEventListener('click', openSettings);
$('btn-settings-run').addEventListener('click', openSettings);

function fillForm(): void {
  form.querySelectorAll<HTMLInputElement>('input[name=mode]').forEach((r) => (r.checked = r.value === settings.mode));
  setVal('volume', String(Math.round(settings.volume * 100)));
  setVal('spatialSpread', String(settings.spatialSpread));
  setVal('soundStyle', settings.soundStyle);
  setVal('sensitivity', settings.sensitivity);
  setVal('blockDistance', String(settings.blockDistance));
  setVal('corridorWidth', String(Math.round(settings.corridorWidth * 100)));
  setVal('fovDeg', String(settings.fovDeg));
  setVal('model', settings.model);
  setVal('verbosity', settings.verbosity);
  setVal('cameraFacing', settings.cameraFacing);
  setVal('theme', settings.theme);
  setVal('mount', settings.mount);
  setChecked('looming', settings.looming);
  setChecked('voiceGuidance', settings.voiceGuidance);
  setChecked('debugOverlay', settings.debugOverlay);
  setChecked('heartbeat', settings.heartbeat);
  setVal('cueDensity', settings.cueDensity);
  setChecked('depthCane', settings.depthCane);
  setVal('echoEverySec', String(settings.echoEverySec));
  setVal('latencyMode', settings.latencyMode);
  setChecked('btKeepAlive', settings.btKeepAlive);
  setVal('soundScene', settings.soundScene);
  setVal('sceneLevel', String(Math.round(settings.sceneLevel * 100)));
  setVal('trackCourse', settings.trackCourse);
  setVal('lineColor', settings.lineColor);
  setVal('edgeSide', settings.edgeSide);
  setVal('trackStyle', settings.trackStyle);
  setVal('earVibration', String(Math.round(settings.earVibration * 100)));
  setChecked('runBeacon', settings.runBeacon);
  setVal('mountHeight', String(settings.mountHeight));
  setVal('edgeGap', String(settings.edgeGap));
  setVal('targetPace', settings.targetPaceS ? `${Math.floor(settings.targetPaceS / 60)}:${String(settings.targetPaceS % 60).padStart(2, '0')}` : '');
  setVal('metronomeSpm', String(settings.metronomeSpm));
  setVal('hrMax', String(settings.hrMax));
  setChecked('trackCountdown', settings.trackCountdown);
  setVal('trackDeadband', String(Math.round(settings.trackDeadband * 100)));
  setChecked('trackHaptics', settings.trackHaptics);
  setVal('trackAnnounce', settings.trackAnnounce);
  setVal('trackAnnounceMinutes', String(settings.trackAnnounceMinutes));
  setVal('lapMeters', String(settings.lapMeters));
  setVal('runStepLength', String(settings.runStepLength));
  setVal('maxHeartRate', String(settings.maxHeartRate));
  setChecked('trackObstacles', settings.trackObstacles);
  setChecked('wideAngle', settings.wideAngle);
  syncOutputs();
}

function setVal(name: string, v: string) {
  (form.elements.namedItem(name) as HTMLInputElement | HTMLSelectElement).value = v;
}
function setChecked(name: string, v: boolean) {
  (form.elements.namedItem(name) as HTMLInputElement).checked = v;
}
function syncOutputs(): void {
  const input = (n: string) => form.elements.namedItem(n) as HTMLInputElement;
  const pairs: [string, string, string][] = [
    ['blockDistance', 'blockDistanceOut', ' metres'],
    ['corridorWidth', 'corridorOut', ' percent'],
    ['fovDeg', 'fovOut', ' degrees'],
    ['spatialSpread', 'spreadOut', ' times'],
    ['trackDeadband', 'deadbandOut', ' percent'],
    ['sceneLevel', '', ' percent'],
    ['earVibration', '', ' percent'],
    ['volume', '', ' percent'],
  ];
  for (const [name, out, unit] of pairs) {
    const el = input(name);
    if (out) (form.elements.namedItem(out) as HTMLOutputElement).value = el.value;
    el.setAttribute('aria-valuetext', el.value + unit); // screen readers say "2 metres", not "2"
  }
}

form.addEventListener('input', (e) => {
  const t = e.target as HTMLInputElement;
  if (!t.name) return;
  syncOutputs();
  const patch: Partial<Settings> = {};
  switch (t.name) {
    case 'mode':
      patch.mode = t.value as Settings['mode'];
      break;
    case 'volume':
      patch.volume = Number(t.value) / 100;
      break;
    case 'corridorWidth':
      patch.corridorWidth = Number(t.value) / 100;
      break;
    case 'blockDistance':
    case 'fovDeg':
    case 'spatialSpread':
    case 'trackAnnounceMinutes':
    case 'lapMeters':
    case 'runStepLength':
    case 'maxHeartRate':
    case 'metronomeSpm':
    case 'hrMax':
    case 'mountHeight':
    case 'edgeGap': {
      const n = Number(t.value);
      if (!Number.isFinite(n) || t.value === '') return;
      patch[t.name] = n;
      break;
    }
    case 'trackDeadband':
      patch.trackDeadband = Number(t.value) / 100;
      break;
    case 'sceneLevel':
      patch.sceneLevel = Number(t.value) / 100;
      break;
    case 'earVibration':
      patch.earVibration = Number(t.value) / 100;
      break;
    case 'echoEverySec':
      patch.echoEverySec = Number(t.value);
      if (patch.echoEverySec > 0) void depthClient.load().catch(() => {});
      break;
    case 'targetPace': {
      const m = /^\s*(\d{1,2}):(\d{2})\s*$/.exec(t.value);
      if (t.value.trim() === '') patch.targetPaceS = 0;
      else if (m) patch.targetPaceS = Number(m[1]) * 60 + Number(m[2]);
      else return; // wait until it's a complete mm:ss
      break;
    }
    case 'cameraId':
      patch.cameraId = t.value;
      void switchCamera(t.value);
      break;
    case 'audioOutputId':
      patch.audioOutputId = t.value;
      void audio
        .setOutput(t.value)
        .then(() => audio.earcon('ok'))
        .catch(() => announcer.say('Could not switch to that sound output.'));
      break;
    case 'looming':
    case 'voiceGuidance':
    case 'debugOverlay':
    case 'heartbeat':
    case 'trackHaptics':
    case 'trackObstacles':
    case 'trackCountdown':
    case 'depthCane':
    case 'btKeepAlive':
    case 'runBeacon':
    case 'wideAngle':
      patch[t.name] = t.checked;
      if (t.name === 'debugOverlay' && !t.checked) clearOverlay(overlay);
      break;
    default:
      (patch as Record<string, string>)[t.name] = t.value;
  }
  update(patch);
  if (t.name === 'cameraFacing') updateMirror();
  if (t.name === 'volume') audio.earcon('ok'); // let the user hear the new level
  if (t.name === 'spatialSpread') void audio.spatialTest(2.5);
  if (t.name === 'metronomeSpm' && track.state === 'running') audio.setMetronome(settings.metronomeSpm);
  if (t.name === 'depthCane' && settings.depthCane) void depthClient.load().catch(() => {});
  if (t.name === 'trackStyle' && settings.trackStyle === 'pg') void audio.loadPgSounds(BASE);
  if (t.name === 'latencyMode') void outputLabel().then((l) => applyLatencyMode(classifyOutput(l)));
});

function update(patch: Partial<Settings>): void {
  settings = { ...settings, ...patch };
  saveSettings(settings);
  applySettings(settings);
}

function applySettings(s: Settings): void {
  audio.setVolume(s.volume);
  audio.setMode(s.mode);
  audio.style = s.soundStyle;
  audio.spread = s.spatialSpread;
  audio.sceneLevel = s.sceneLevel;
  audio.setKeepAlive(s.btKeepAlive);
  if (s.soundScene !== 'surround') audio.updateScene([]);
  announcer.voiceGuidance = s.voiceGuidance;
  session.applySettings(simOverrides ? { ...s, ...simOverrides } : s);
  if (s.theme === 'auto') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = s.theme;
  $('pip').hidden = !s.debugOverlay;
  $('tpip').hidden = !s.debugOverlay;
  renderMount();
  renderActivity();
  applyMountUi();
}

$('btn-hp-check').addEventListener('click', async () => {
  dialog.close();
  await audio.unlock().catch(() => {});
  const wasRunning = session.state === 'running';
  if (wasRunning) {
    session.pause();
    setPaused(true);
  }
  await headphoneCheck();
  if (wasRunning) {
    session.resume();
    setPaused(false);
  }
  show(session.state === 'idle' ? 'welcome' : 'running');
});

$('btn-spatial-test').addEventListener('click', async (e) => {
  const btn = e.currentTarget as HTMLButtonElement;
  await audio.unlock().catch(() => {});
  if (settings.audioOutputId) await audio.setOutput(settings.audioOutputId).catch(() => {});
  btn.disabled = true;
  btn.textContent = 'Listen: the sound circles all the way around you…';
  announcer.showText('Playing spatial test. The sound circles all the way around you: ahead, right, behind, left.');
  await audio.spatialTest();
  btn.disabled = false;
  btn.textContent = 'Test spatial sound (full circle)';
});

/** Fill the camera and sound-output pickers (labels need camera permission first). */
async function refreshDevices(): Promise<void> {
  const camSel = $<HTMLSelectElement>('camera-select');
  const outSel = $<HTMLSelectElement>('output-select');
  const cams = await listCameras().catch(() => []);
  fillSelect(camSel, 'Automatic (rear camera on phones)', cams, settings.cameraId, 'Camera');
  const devices = (await navigator.mediaDevices?.enumerateDevices().catch(() => [])) ?? [];
  const outs = devices.filter((d) => d.kind === 'audiooutput' && d.deviceId !== 'default' && d.deviceId !== 'communications');
  if (AudioEngine.canChooseOutput) {
    outSel.disabled = false;
    fillSelect(outSel, 'System default', outs, settings.audioOutputId, 'Output');
  } else {
    outSel.disabled = true;
    fillSelect(outSel, 'Follows your device (choose headphones in Bluetooth settings)', [], '', 'Output');
  }
}

function fillSelect(sel: HTMLSelectElement, auto: string, list: MediaDeviceInfo[], current: string, fallback: string): void {
  sel.replaceChildren(new Option(auto, ''));
  list.forEach((d, i) => sel.add(new Option(d.label || `${fallback} ${i + 1}`, d.deviceId)));
  sel.value = list.some((d) => d.deviceId === current) ? current : '';
}

$('btn-calibrate').addEventListener('click', () => {
  const m = Number($<HTMLInputElement>('calib-m').value);
  if (session.state === 'idle') {
    announcer.say('Start walking mode first, with one person standing straight ahead.');
    return;
  }
  const fov = Number.isFinite(m) && m > 0 ? session.calibrateFov(m) : null;
  if (fov === null) {
    announcer.say('No single person clearly in view. Ask them to stand fully in frame, straight ahead, then try again.');
    return;
  }
  update({ fovDeg: fov });
  fillForm();
  audio.earcon('ok');
  announcer.say(`Calibrated. Field of view set to ${fov} degrees.`);
});

$('btn-disclaimer').addEventListener('click', () => {
  announcer.unlock();
  readDisclaimer();
});

$('btn-offline').addEventListener('click', async (e) => {
  const btn = e.currentTarget as HTMLButtonElement;
  btn.disabled = true;
  const files = [
    ...Object.values(MODELS).map((m) => m.file),
    'vendor/mediapipe/vision_wasm_nosimd_internal.wasm',
    'vendor/ort/ort-wasm-simd-threaded.jsep.wasm',
    'vendor/ort/ort-wasm-simd-threaded.jsep.mjs',
  ];
  try {
    for (const [i, f] of files.entries()) {
      btn.textContent = `Saving ${i + 1} of ${files.length}…`;
      // The service worker caches these on the way through (CacheFirst).
      const r = await fetch(new URL(f, BASE));
      await r.arrayBuffer();
    }
    btn.textContent = 'All models saved for offline use';
    announcer.say('All models saved for offline use.');
  } catch {
    btn.textContent = 'Saving failed. Tap to retry.';
    announcer.say('Saving models failed. Check your connection.');
  } finally {
    btn.disabled = false;
  }
});

$<HTMLInputElement>('file-video').addEventListener('change', (e) => {
  const f = (e.target as HTMLInputElement).files?.[0] ?? null;
  testVideo = f;
  announcer.say(f ? `Test video selected. Tap Start to use it instead of the camera.` : 'Using the camera.');
});

$('btn-log').addEventListener('click', () => {
  const blob = new Blob(
    [JSON.stringify({ app: 'EchoPath', exportedAt: new Date().toISOString(), settings, events: session.log }, null, 2)],
    { type: 'application/json' },
  );
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `echopath-log-${Date.now()}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});

$('btn-reset').addEventListener('click', () => {
  update({ ...DEFAULT_SETTINGS, disclaimerAccepted: settings.disclaimerAccepted, headphoneCheckDone: settings.headphoneCheckDone });
  fillForm();
  announcer.say('Settings reset.');
});

dialog.addEventListener('close', () => {
  (track.state !== 'idle' ? $('track-target') : session.state === 'idle' ? $('btn-start') : pauseTarget).focus();
});

// ---------------------------------------------------------------------------
// Voice menu (eyes-free start): speaks, listens, and always works by taps
// ---------------------------------------------------------------------------
const listener = new Listener();
const voiceMenu = new VoiceMenu({
  announcer,
  audio,
  listener,
  getSettings: () => settings,
  update,
  startWalk: () => void $('btn-start').click(),
  startTrack: () => void $('btn-start').click(),
  startSimulator: () => void startSimulator(),
  soundCheck: () => audio.spatialTest(4),
  render: renderVoice,
  close: () => {
    /* the started mode shows its own screen */
  },
});

function renderVoice(step: MenuStep, hi: number, heard: string): void {
  $('voice-title').textContent = step.title;
  $('voice-prompt').textContent = step.prompt;
  const ol = $('voice-options');
  ol.replaceChildren(
    ...step.options.map((o, i) => {
      const li = document.createElement('li');
      li.textContent = o.label;
      if (i === hi) li.dataset.hi = '';
      return li;
    }),
  );
  $('voice-heard').textContent = heard;
  $('voice-target-label').textContent = `Tap to choose: ${step.options[hi]?.label ?? ''}`;
}

/** Tap / hold / double-tap on the voice screen (single tap waits briefly to rule out a double). */
(() => {
  const el = $('voice-target');
  const HOLD = 600, DOUBLE = 350;
  let timer: number | undefined, tapTimer: number | undefined, held = false, taps = 0, lastPointer = 0;
  const first = async () => {
    // The very first tap unlocks audio and speech (browsers require a tap).
    await audio.unlock().catch(() => {});
    announcer.unlock();
    voiceMenu.begin();
  };
  const tap = () => (voiceMenu.active ? voiceMenu.tap() : void first());
  el.addEventListener('pointerdown', () => {
    held = false;
    clearTimeout(timer);
    timer = window.setTimeout(() => {
      held = true;
      navigator.vibrate?.(30);
      if (voiceMenu.active) voiceMenu.hold();
      else void first();
    }, HOLD);
  });
  const cancel = () => clearTimeout(timer);
  el.addEventListener('pointercancel', cancel);
  el.addEventListener('pointerleave', cancel);
  el.addEventListener('pointerup', () => {
    clearTimeout(timer);
    lastPointer = performance.now();
    if (held) return;
    taps++;
    clearTimeout(tapTimer);
    tapTimer = window.setTimeout(() => {
      const n = taps;
      taps = 0;
      if (n >= 2 && voiceMenu.active) voiceMenu.back();
      else tap();
    }, DOUBLE);
  });
  el.addEventListener('contextmenu', (e) => e.preventDefault());
  // Screen readers / keyboard: activation = choose.
  el.addEventListener('click', () => {
    if (performance.now() - lastPointer > 600) tap();
  });
  el.addEventListener('keydown', (e) => {
    if (!voiceMenu.active) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowRight') {
      e.preventDefault();
      voiceMenu.hold();
    } else if (e.key === 'Escape' || e.key === 'Backspace' || e.key === 'ArrowLeft') {
      e.preventDefault();
      voiceMenu.back();
    }
  });
})();

$('btn-visual-menu').addEventListener('click', () => {
  voiceMenu.active = false;
  listener.stop();
  announcer.cancel();
  update({ voiceMenu: false });
  show('welcome');
});
$('btn-voice-menu').addEventListener('click', async () => {
  update({ voiceMenu: true });
  show('voice');
  await audio.unlock().catch(() => {});
  announcer.unlock();
  voiceMenu.begin();
});

/** After stopping: back to the voice menu (eyes-free) or the visual home. */
function returnHome(): void {
  if (settings.voiceMenu) {
    show('voice');
    setTimeout(() => voiceMenu.begin(), 2500);
  } else show('welcome');
}

// Initial state (after every const above is initialised).
applySettings(settings);
if (settings.voiceMenu) show('voice');
void audio.setOutput(settings.audioOutputId); // remembered headphones; applied when audio starts
void refreshChecks();

// Dev/test hook (used by automated checks; harmless in production).
(window as unknown as { echopath: unknown }).echopath = { get sim() { return sim; }, get wsim() { return wsim; }, voiceMenu, session, track, audio, detector, motion, runTracker, get settings() { return settings; } };
