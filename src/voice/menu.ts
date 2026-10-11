import type { AudioEngine } from '../audio/engine';
import type { Settings } from '../core/settings';
import type { Announcer } from '../speech/announcer';
import { matchIntent, matchLabel, type Intent } from './intents';
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
  /** Read the options out after the prompt (default true). */
  listOptions?: boolean;
}

export interface MenuDeps {
  announcer: Announcer;
  audio: AudioEngine;
  listener: Listener;
  getSettings: () => Settings;
  update: (patch: Partial<Settings>) => void;
  /** Start a scene: live-walk, live-line, live-lane, or a simulation (walk, stadium, road). */
  startScene: (scene: string) => void;
  soundCheck: () => Promise<void>;
  render: (step: MenuStep, highlighted: number, heard: string) => void;
  /** Leave the voice menu (guidance started, or the visual menu chosen). */
  close: () => void;
}

const GLOBAL: Intent[] = ['back', 'help'];

/** " Options: Live view, Simulation, Sound check, or Settings." */
function optionsSentence(st: MenuStep): string {
  if (st.listOptions === false || st.id === 'disclaimer') return '';
  const names = st.options.map((o) => o.label.replace(/:/g, ','));
  if (names.length === 1) return ` Say ${names[0]}.`;
  return ` Options: ${names.slice(0, -1).join(', ')}, or ${names[names.length - 1]}.`;
}

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
        title: 'Live view or simulation?',
        prompt: 'Live view or simulation? Live view uses your camera in the real world. Simulation needs no camera.',
        options: [
          { label: 'Live view', intents: ['live', 'walk', 'run', 'scan'], run: go('live') },
          { label: 'Simulation', intents: ['simulator'], run: go('practice') },
          { label: 'Sound check', intents: ['sound'], run: () => this.soundCheck() },
          { label: 'Settings', intents: ['settings'], run: go('settings') },
        ],
      },
      live: {
        id: 'live',
        title: 'Which live view?',
        prompt: 'Which live view?',
        options: [
          { label: 'Scan around me, then walk', intents: ['walk', 'scan'], run: () => this.start('live-walk') },
          { label: 'Walk or run along a painted line', intents: ['line'], run: () => this.start('live-line') },
          { label: 'Run in a track lane', intents: ['lanes', 'run'], run: () => this.start('live-lane') },
          { label: 'Back', intents: ['done'], run: () => this.back() },
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
              // The voice menu has its own sound check, so skip the visual one.
              d.update({ disclaimerAccepted: true, headphoneCheckDone: true });
              const scene = this.pending ?? 'live-walk';
              this.pending = null;
              this.close();
              d.startScene(scene);
            },
          },
        ],
      },
      practice: {
        id: 'practice',
        title: 'Which simulation?',
        prompt: 'Which simulation?',
        options: [
          { label: 'Walk: park path with obstacles and people', intents: ['walk'], run: () => this.start('walk') },
          { label: 'Run: 400 metre track', intents: ['run', 'lanes'], run: () => this.start('stadium') },
          { label: 'Run: road with a yellow guide line', intents: ['line'], run: () => this.start('road') },
          { label: 'Back', intents: ['done'], run: () => this.back() },
        ],
      },
      settings: {
        id: 'settings',
        title: 'Settings',
        prompt: 'Settings.',
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

  /** Scene waiting for the safety notice to be accepted. */
  private pending: string | null = null;

  /** Start a scene; live views need the safety notice accepted first. */
  private start(scene: string): void {
    const live = scene.startsWith('live');
    if (live && !this.d.getSettings().disclaimerAccepted) {
      this.pending = scene;
      return this.open('disclaimer');
    }
    this.close();
    this.d.startScene(scene);
  }

  /** Show the first question on screen straight away, silently (speech needs a tap first). */
  preview(): void {
    this.active = false;
    this.stack = [];
    this.step = this.steps().activity;
    this.hi = 0;
    this.d.render(this.step, 0, '');
  }

  /** Begin (from the first tap, which also unlocks audio and speech). `intro` is said first. */
  begin(intro = ''): void {
    this.active = true;
    this.stack = [];
    this.intro = intro;
    this.step = null;
    this.open('activity');
  }

  /** Said once before the first question (e.g. how EchoPath works). */
  private intro = '';

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
    this.d.announcer.say(this.intro + st.prompt + optionsSentence(st) + taps, { interrupt: true, system: false, priority: 0 });
    this.intro = '';
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
      // Not a keyword: maybe the option's own name ("sound check", "park path").
      const byName = matchLabel(heard.alternatives, st.options.map((o) => o.label));
      if (byName !== null) {
        this.misses = 0;
        const opt = st.options[byName];
        this.d.render(st, byName, `Heard: "${shown}"`);
        void opt.run();
        return;
      }
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
      listOptions: false,
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
      listOptions: false,
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
