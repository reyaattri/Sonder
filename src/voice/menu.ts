import type { AudioEngine } from '../audio/engine';
import type { Settings } from '../core/settings';
import type { Announcer } from '../speech/announcer';
import { matchIntent, type Intent } from './intents';
import type { Heard, Listener } from './listener';

/**
 * Eyes-free voice menu. Every step SPEAKS its question and options, then
 * listens for a spoken answer. Taps always work too, so it never depends on
 * speech recognition:
 *
 *   tap once          - choose the highlighted option
 *   press and hold    - move to (and hear) the next option
 *   double-tap        - go back
 *
 * When speech isn't understood it says so plainly and explains the taps.
 */

export interface MenuOption {
  label: string;
  intents: Intent[];
  run: () => void | Promise<void>;
}

export interface MenuStep {
  id: string;
  title: string;
  prompt: string;
  options: MenuOption[];
}

export interface MenuDeps {
  announcer: Announcer;
  audio: AudioEngine;
  listener: Listener;
  getSettings: () => Settings;
  update: (patch: Partial<Settings>) => void;
  startWalk: () => void;
  startTrack: () => void;
  startSimulator: () => void;
  /** Live camera: scan around you, then walk. */
  startLiveWalk: () => void;
  /** Any practice scene from the dropdown (walk, stadium, road, purple, pg-photo, photo-walk). */
  startScene: (scene: string) => void;
  soundCheck: () => Promise<void>;
  render: (step: MenuStep, highlighted: number, heard: string) => void;
  /** Leave the voice menu (guidance started, or the visual menu chosen). */
  close: () => void;
}

const GLOBAL: Intent[] = ['back', 'help'];

export class VoiceMenu {
  private stack: string[] = [];
  private step: MenuStep | null = null;
  private hi = 0;
  private listening = 0;
  active = false;

  constructor(private readonly d: MenuDeps) {}

  private steps(): Record<string, MenuStep> {
    const d = this.d;
    const s = d.getSettings();
    const go = (id: string) => () => this.open(id);
    const set = (patch: Partial<Settings>, say: string, then?: string) => () => {
      d.update(patch);
      d.audio.earcon('ok');
      d.announcer.say(say, { interrupt: true, system: false, priority: 0 });
      if (then) setTimeout(() => this.open(then), 1200);
      else setTimeout(() => this.refresh(), 1200);
    };
    return {
      activity: {
        id: 'activity',
        title: 'What would you like to do?',
        prompt: 'What would you like to do? Walk, live scan, run, or practice.',
        options: [
          { label: 'Walk', intents: ['walk'], run: () => (d.update({ activity: 'walk' }), this.open('mount')) },
          {
            label: 'Live: scan around me, then walk',
            intents: ['live', 'scan'],
            run: () => {
              d.update({ activity: 'walk' });
              if (!d.getSettings().disclaimerAccepted) return this.open('disclaimer');
              this.close();
              d.startLiveWalk();
            },
          },
          { label: 'Run on a track', intents: ['run', 'lanes'], run: () => (d.update({ activity: 'track' }), this.open('course')) },
          { label: 'Practice', intents: ['simulator', 'photo'], run: go('practice') },
          { label: 'Sound check', intents: ['sound'], run: () => this.soundCheck() },
          { label: 'Settings', intents: ['settings'], run: go('settings') },
        ],
      },
      mount: {
        id: 'mount',
        title: 'Where is the phone?',
        prompt: 'Where is your phone? Chest, waist, in your hand, or on a table.',
        options: [
          { label: 'Chest', intents: ['chest'], run: () => (d.update({ mount: 'chest' }), this.open('ready')) },
          { label: 'Waist', intents: ['waist'], run: () => (d.update({ mount: 'waist' }), this.open('ready')) },
          { label: 'In my hand', intents: ['hand'], run: () => (d.update({ mount: 'hand' }), this.open('ready')) },
          { label: 'On a table', intents: ['table'], run: () => (d.update({ mount: 'table' }), this.open('ready')) },
        ],
      },
      course: {
        id: 'course',
        title: 'Where are you running?',
        prompt: 'Where are you running? Track lanes, a painted guide line, or along a kerb.',
        options: [
          { label: 'Track lanes', intents: ['lanes', 'run'], run: () => (d.update({ trackCourse: 'lanes' }), this.open('ready')) },
          { label: 'A painted guide line', intents: ['line'], run: () => (d.update({ trackCourse: 'line' }), this.open('ready')) },
          { label: 'Along a kerb or road edge', intents: ['edge'], run: () => (d.update({ trackCourse: 'edge' }), this.open('ready')) },
          { label: 'Practice in the simulator', intents: ['simulator'], run: () => (this.close(), d.startSimulator()) },
        ],
      },
      ready: {
        id: 'ready',
        title: 'Ready',
        prompt: `Ready to ${s.activity === 'track' ? 'run' : 'walk'}. Say start, or tap once to start.`,
        options: [
          {
            label: 'Start',
            intents: ['start', 'yes'],
            run: () => {
              if (!s.disclaimerAccepted) return this.open('disclaimer');
              // The voice menu has its own sound check, so skip the visual one.
              d.update({ headphoneCheckDone: true });
              this.close();
              if (s.activity === 'track') d.startTrack();
              else d.startWalk();
            },
          },
          { label: 'Sound check first', intents: ['sound'], run: () => this.soundCheck() },
          { label: 'Settings', intents: ['settings'], run: go('settings') },
        ],
      },
      disclaimer: {
        id: 'disclaimer',
        title: 'Before you start',
        prompt:
          'Before you start. EchoPath is a supplementary aid, not a replacement for a cane, a guide dog or sighted help. It can miss obstacles, especially glass, stairs, drop-offs and anything in low light. Silence means nothing was detected, never that the way is safe. Video stays on this phone. Say I understand, or tap once to agree.',
        options: [
          {
            label: 'I understand',
            intents: ['yes', 'start', 'done'],
            run: () => {
              d.update({ disclaimerAccepted: true, headphoneCheckDone: true });
              const fromLive = this.stack.includes('activity') && this.stack[this.stack.length - 1] === 'activity';
              this.close();
              if (d.getSettings().activity === 'track') d.startTrack();
              else if (fromLive) d.startLiveWalk();
              else d.startWalk();
            },
          },
        ],
      },
      practice: {
        id: 'practice',
        title: 'Practice',
        prompt: 'Practice. Walk simulator, track simulator, purple line, or real photo.',
        options: [
          { label: 'Walk simulator: obstacles and people', intents: ['walk'], run: () => (this.close(), d.startScene('walk')) },
          { label: 'Track simulator: 400 metre track', intents: ['run', 'lanes'], run: () => (this.close(), d.startScene('stadium')) },
          { label: 'Purple guide line, Google model', intents: ['line'], run: () => (this.close(), d.startScene('purple')) },
          { label: 'Real photo from Google Project Guideline', intents: ['photo', 'live'], run: () => (this.close(), d.startScene('photo-walk')) },
          { label: 'Back', intents: ['done'], run: () => this.back() },
        ],
      },
      settings: {
        id: 'settings',
        title: 'Settings',
        prompt: 'Settings. Say louder, quieter, calmer, more detail, surround on or off, cane on or off, echo on or off, or done.',
        options: [
          { label: 'Louder', intents: ['louder'], run: set({ volume: Math.min(1, s.volume + 0.15) }, 'Louder.') },
          { label: 'Quieter', intents: ['quieter'], run: set({ volume: Math.max(0.1, s.volume - 0.15) }, 'Quieter.') },
          { label: 'Calmer cues', intents: ['calmer'], run: set({ cueDensity: 'calm' }, 'Calm cues.') },
          { label: 'More detail', intents: ['detailed'], run: set({ cueDensity: 'detailed' }, 'Detailed cues.') },
          {
            label: s.soundScene === 'surround' ? 'Turn surround sound off' : 'Turn surround sound on',
            intents: ['surroundOn', 'surroundOff'],
            run: set({ soundScene: s.soundScene === 'surround' ? 'cues' : 'surround' }, s.soundScene === 'surround' ? 'Surround off.' : 'Surround on.'),
          },
          {
            label: s.depthCane ? 'Turn the virtual cane off' : 'Turn the virtual cane on',
            intents: ['caneOn', 'caneOff'],
            run: set({ depthCane: !s.depthCane }, s.depthCane ? 'Virtual cane off.' : 'Virtual cane on.'),
          },
          {
            label: s.echoEverySec > 0 ? 'Turn echolocation off' : 'Turn echolocation on',
            intents: ['echoOn', 'echoOff'],
            run: set({ echoEverySec: s.echoEverySec > 0 ? 0 : 3 }, s.echoEverySec > 0 ? 'Echolocation off.' : 'Echolocation on, every three seconds.'),
          },
          { label: 'Done', intents: ['done', 'back'], run: () => this.back() },
        ],
      },
    };
  }

  /** Begin (from the first tap, which also unlocks audio and speech). */
  begin(): void {
    this.active = true;
    this.stack = [];
    this.open('activity');
  }

  open(id: string, push = true): void {
    const step = this.steps()[id];
    if (!step) return;
    this.misses = 0;
    if (push && this.step && this.step.id !== id) this.stack.push(this.step.id);
    this.step = step;
    this.hi = 0;
    this.speakStep();
  }

  private refresh(): void {
    if (this.step) {
      this.step = this.steps()[this.step.id];
      this.d.render(this.step, this.hi, '');
      void this.listen();
    }
  }

  private speakStep(heard = ''): void {
    const st = this.step!;
    this.d.render(st, this.hi, heard);
    const taps = this.d.listener.supported
      ? ''
      : ' Tap once for ' + st.options[0].label + '. Press and hold for other options.';
    this.d.announcer.say(st.prompt + taps, { interrupt: true, system: false, priority: 0 });
    void this.listen();
  }

  /** Listen for an answer after the question has been spoken. */
  private async listen(): Promise<void> {
    if (!this.d.listener.supported || !this.step) return;
    const token = ++this.listening;
    await this.d.announcer.whenIdle();
    if (token !== this.listening || !this.active) return;
    this.d.audio.earcon('tick'); // "I'm listening"
    this.d.render(this.step, this.hi, 'Listening…');
    const step = this.step;
    const heard = await this.d.listener.listen(7000, (t) => {
      if (token === this.listening && this.step === step) this.d.render(step, this.hi, `Hearing: "${t}"`);
    });
    if (token !== this.listening || !this.active) return;
    if (!heard) {
      // Silence: keep the screen calm; taps still work.
      this.d.render(this.step, this.hi, '');
      return;
    }
    this.handleSpeech(heard);
  }

  /** Consecutive answers not understood at this step. */
  private misses = 0;

  private handleSpeech(heard: Heard): void {
    const st = this.step!;
    const allowed = [...new Set([...st.options.flatMap((o) => o.intents), ...GLOBAL])];
    const m = matchIntent(heard.alternatives, allowed);
    const shown = heard.alternatives[0]?.trim() ?? '';
    if (!m) {
      this.misses++;
      this.d.render(st, this.hi, `Heard: "${shown}"`);
      this.d.audio.earcon('attention');
      // First miss: ask again with the choices. Then explain the taps.
      const say =
        this.misses === 1
          ? `Sorry, I didn't catch that. You can say: ${st.options.map((o) => o.label).join(', ')}.`
          : `Sorry, I still didn't understand. Tap once for ${st.options[this.hi].label}. Press and hold for other options. Double-tap to go back.`;
      this.d.announcer.say(say, { interrupt: true, system: false, priority: 0 });
      void this.listen();
      return;
    }
    this.misses = 0;
    if (m.intent === 'back') return this.back();
    if (m.intent === 'help') return this.speakStep(`Heard: "${shown}"`);
    const opt = st.options.find((o) => o.intents.includes(m.intent));
    if (!opt) return;
    // A guess (sound-alike or near miss) from a hesitant recogniser: check first.
    if (!m.exact && heard.confidence < 0.6 && st.id !== 'confirm') return this.confirm(opt, m.said);
    this.d.render(st, st.options.indexOf(opt), `Heard: "${shown}"`);
    void opt.run();
  }

  private confirm(opt: MenuOption, said: string): void {
    const back = this.step!;
    this.step = {
      id: 'confirm',
      title: `Did you mean ${opt.label}?`,
      prompt: `Did you mean ${opt.label}? Say yes or no.`,
      options: [
        { label: `Yes, ${opt.label}`, intents: ['yes'], run: () => ((this.step = back), void opt.run()) },
        { label: 'No', intents: ['no', 'back'], run: () => ((this.step = back), this.speakStep()) },
      ],
    };
    this.hi = 0;
    this.d.render(this.step, 0, `Heard: "${said}"`);
    this.d.announcer.say(this.step.prompt, { interrupt: true, system: false, priority: 0 });
    void this.listen();
  }

  // ---- gestures ------------------------------------------------------------
  tap(): void {
    if (!this.step) return;
    this.listening++;
    this.d.listener.stop();
    void this.step.options[this.hi].run();
  }

  /** Next option (wraps), spoken. */
  hold(): void {
    if (!this.step) return;
    this.listening++;
    this.d.listener.stop();
    this.hi = (this.hi + 1) % this.step.options.length;
    this.d.render(this.step, this.hi, '');
    this.d.announcer.say(`${this.step.options[this.hi].label}. Tap to choose.`, { interrupt: true, system: false, priority: 0 });
    void this.listen();
  }

  back(): void {
    this.listening++;
    this.d.listener.stop();
    const prev = this.stack.pop();
    if (prev) this.open(prev, false);
    else {
      this.d.audio.earcon('attention');
      this.d.announcer.say('This is the first question.', { interrupt: true, system: false, priority: 0 });
      void this.listen();
    }
  }

  private async soundCheck(): Promise<void> {
    const returnTo = this.step?.id ?? 'activity';
    this.listening++;
    this.d.listener.stop();
    this.d.announcer.say('Listen. The sound will circle all the way around your head.', { interrupt: true, system: false, priority: 0 });
    await this.d.announcer.whenIdle();
    await this.d.soundCheck();
    this.d.announcer.say('Did you hear it go all the way around you? Say yes or no. Or tap once for yes.', {
      interrupt: true,
      system: false,
      priority: 0,
    });
    this.step = {
      id: 'heard',
      title: 'Did you hear it go around you?',
      prompt: 'Did you hear it go all the way around you? Say yes or no.',
      options: [
        {
          label: 'Yes',
          intents: ['yes'],
          run: () => {
            this.d.announcer.say('Great. Spatial sound is working.', { interrupt: true, system: false, priority: 0 });
            setTimeout(() => this.open(returnTo, false), 1500);
          },
        },
        {
          label: 'No',
          intents: ['no'],
          run: () => {
            this.d.announcer.say(
              'Your headphones may not be connected, or they are in hands-free mode, which is mono. On a laptop, connect the headphones in Bluetooth settings and choose the entry called headphones, not headset. Then try again.',
              { interrupt: true, system: false, priority: 0 },
            );
            setTimeout(() => this.open(returnTo, false), 9000);
          },
        },
      ],
    };
    this.hi = 0;
    this.d.render(this.step, 0, '');
    void this.listen();
  }

  close(): void {
    this.active = false;
    this.listening++;
    this.d.listener.stop();
    this.d.close();
  }
}
