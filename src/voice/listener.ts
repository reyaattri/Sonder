/**
 * Speech recognition (Web Speech API). Chrome and Edge support it; Safari
 * partly; Firefox not. Listening opens the microphone, which can switch
 * Bluetooth headsets into mono call mode for a moment, so the app listens
 * only in menus and on push-to-talk, never continuously during guidance.
 */
type Alt = { transcript: string; confidence: number };
type Result = ArrayLike<Alt> & { isFinal?: boolean };
type Rec = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  onresult: ((e: { resultIndex?: number; results: ArrayLike<Result> }) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  abort(): void;
};

export interface Heard {
  /** All alternatives joined (kept for older callers). */
  text: string;
  /** Every alternative the recogniser offered, best first. */
  alternatives: string[];
  confidence: number;
}

export class Listener {
  private rec: Rec | null = null;
  /** Set when the user/browser refused the microphone: stop asking. */
  denied = false;

  get supported(): boolean {
    const w = window as unknown as { SpeechRecognition?: unknown; webkitSpeechRecognition?: unknown };
    return !this.denied && !!(w.SpeechRecognition || w.webkitSpeechRecognition);
  }

  /**
   * Listen once. Resolves null on silence, error, or timeout.
   * `onInterim` receives the words as they are recognised (live captions).
   */
  listen(timeoutMs = 6000, onInterim?: (text: string) => void): Promise<Heard | null> {
    if (!this.supported) return Promise.resolve(null);
    const w = window as unknown as { SpeechRecognition?: new () => Rec; webkitSpeechRecognition?: new () => Rec };
    const Ctor = (w.SpeechRecognition ?? w.webkitSpeechRecognition)!;
    this.stop();
    const rec = new Ctor();
    this.rec = rec;
    rec.lang = navigator.language || 'en-US';
    rec.continuous = false;
    rec.interimResults = true;
    rec.maxAlternatives = 5;
    return new Promise((resolve) => {
      let done = false;
      let lastInterim = '';
      const finish = (h: Heard | null) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        try {
          rec.abort();
        } catch {
          /* already stopped */
        }
        resolve(h);
      };
      const timer = window.setTimeout(() => finish(lastInterim ? fromText(lastInterim) : null), timeoutMs);
      rec.onresult = (e) => {
        const results = Array.from(e.results);
        const final = results.find((r) => r.isFinal);
        if (final) {
          const alts = Array.from(final).filter((a) => a.transcript.trim());
          if (alts.length)
            finish({ text: alts.map((a) => a.transcript).join(' | '), alternatives: alts.map((a) => a.transcript), confidence: alts[0].confidence ?? 0 });
          return;
        }
        lastInterim = results.map((r) => r[0]?.transcript ?? '').join(' ').trim();
        if (lastInterim) onInterim?.(lastInterim);
      };
      rec.onerror = (e) => {
        if (e.error === 'not-allowed' || e.error === 'service-not-allowed') this.denied = true;
        finish(null);
      };
      // Ended without a final result: use what we had heard so far.
      rec.onend = () => finish(lastInterim ? fromText(lastInterim) : null);
      try {
        rec.start();
      } catch {
        finish(null);
      }
    });
  }

  stop(): void {
    try {
      this.rec?.abort();
    } catch {
      /* ignore */
    }
    this.rec = null;
  }
}

const fromText = (t: string): Heard => ({ text: t, alternatives: [t], confidence: 0.4 });
