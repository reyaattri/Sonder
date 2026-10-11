/**
 * Speech output on the device's own text-to-speech (speechSynthesis).
 *
 * - At most one utterance every 2 s, most urgent first (US-6.3).
 * - Cues are ducked by ~12 dB while speaking (the `onDuck` callback).
 * - System messages can interrupt; warnings never cut off speech in progress.
 * - When voice guidance is off, system messages go only to an ARIA live
 *   region so a running screen reader reads them once, not twice.
 */
export interface SpeakOptions {
  /** Lower = more urgent. */
  priority?: number;
  /** Cancel whatever is speaking (camera lost, critical errors). */
  interrupt?: boolean;
  /** System guidance (vs. an obstacle warning). */
  system?: boolean;
}

interface Pending {
  text: string;
  priority: number;
  queuedAt: number;
}

const MIN_GAP_MS = 2000;
const STALE_MS = 1500;

export class Announcer {
  voiceGuidance = true;
  private queue: Pending[] = [];
  private speaking = false;
  private lastStart = -Infinity;
  private timer: number | undefined;
  private watchdog: number | undefined;
  private readonly synth: SpeechSynthesis | undefined =
    typeof speechSynthesis !== 'undefined' ? speechSynthesis : undefined;

  constructor(
    private readonly live: { polite: HTMLElement; assertive: HTMLElement },
    private readonly onDuck: (ducked: boolean) => void,
  ) {}

  get supported(): boolean {
    return this.synth !== undefined;
  }

  /** iOS only allows speech after a user gesture: call from the Start tap. */
  unlock(): void {
    if (!this.synth) return;
    const u = new SpeechSynthesisUtterance(' ');
    u.volume = 0;
    this.synth.speak(u);
  }

  /** Write to the screen-reader live region (always safe). */
  showText(text: string, assertive = false): void {
    const el = assertive ? this.live.assertive : this.live.polite;
    el.textContent = '';
    // Re-setting on the next tick makes screen readers announce repeats too.
    setTimeout(() => (el.textContent = text), 30);
  }

  say(text: string, opts: SpeakOptions = {}): void {
    const system = opts.system ?? true;
    if (system && !this.voiceGuidance) {
      this.showText(text, opts.interrupt);
      return;
    }
    if (!this.synth) {
      this.showText(text, true);
      return;
    }
    if (opts.interrupt) {
      this.queue = [];
      this.synth.cancel();
      this.speaking = false;
      this.lastStart = -Infinity;
    }
    this.queue.push({ text, priority: opts.priority ?? (system ? 0 : 5), queuedAt: performance.now() });
    this.queue.sort((a, b) => a.priority - b.priority);
    this.pump();
  }

  /** Whether a new warning could be spoken right now (used to avoid queueing stale ones). */
  get ready(): boolean {
    return !this.speaking && performance.now() - this.lastStart >= MIN_GAP_MS;
  }

  cancel(): void {
    this.queue = [];
    this.synth?.cancel();
    this.finish();
  }

  private pump(): void {
    if (!this.synth || this.speaking || this.queue.length === 0) return;
    const now = performance.now();
    this.queue = this.queue.filter((p) => p.priority === 0 || now - p.queuedAt < STALE_MS);
    if (this.queue.length === 0) return;
    const wait = MIN_GAP_MS - (now - this.lastStart);
    if (wait > 0) {
      clearTimeout(this.timer);
      this.timer = window.setTimeout(() => this.pump(), wait);
      return;
    }
    const next = this.queue.shift()!;
    const u = new SpeechSynthesisUtterance(next.text);
    u.rate = 1.15;
    u.onend = u.onerror = () => this.finish();
    this.speaking = true;
    this.lastStart = now;
    this.onDuck(true);
    this.synth.speak(u);
    // Some engines never fire onend; never leave cues ducked forever.
    clearTimeout(this.watchdog);
    this.watchdog = window.setTimeout(() => this.finish(), 1000 + next.text.length * 90);
  }

  private finish(): void {
    clearTimeout(this.watchdog);
    if (!this.speaking) return;
    this.speaking = false;
    this.onDuck(false);
    if (this.queue.length) this.pump();
  }
}
