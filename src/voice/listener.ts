/**
 * Speech recognition for the voice menu (Web Speech API). Chrome and Edge
 * support it; Safari partly; Firefox not. Listening opens the microphone,
 * which can switch Bluetooth headsets into mono call mode for a moment, so
 * the app only listens in menus, never during guidance.
 */
type Rec = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string; confidence: number }>> }) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  abort(): void;
};

export interface Heard {
  /** All alternatives joined (the parser looks for keywords in any of them). */
  text: string;
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

  /** Listen once. Resolves null on silence, error, or timeout. */
  listen(timeoutMs = 6000): Promise<Heard | null> {
    if (!this.supported) return Promise.resolve(null);
    const w = window as unknown as { SpeechRecognition?: new () => Rec; webkitSpeechRecognition?: new () => Rec };
    const Ctor = (w.SpeechRecognition ?? w.webkitSpeechRecognition)!;
    this.stop();
    const rec = new Ctor();
    this.rec = rec;
    rec.lang = navigator.language || 'en-US';
    rec.continuous = false;
    rec.interimResults = false;
    rec.maxAlternatives = 4;
    return new Promise((resolve) => {
      let done = false;
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
      const timer = window.setTimeout(() => finish(null), timeoutMs);
      rec.onresult = (e) => {
        const alts = Array.from(e.results[0] ?? []);
        finish({ text: alts.map((a) => a.transcript).join(' | '), confidence: alts[0]?.confidence ?? 0 });
      };
      rec.onerror = (e) => {
        if (e.error === 'not-allowed' || e.error === 'service-not-allowed') this.denied = true;
        finish(null);
      };
      rec.onend = () => finish(null);
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
