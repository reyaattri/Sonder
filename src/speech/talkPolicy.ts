/**
 * Decides whether something is worth SAYING right now. Sounds already carry
 * where things are, continuously; speech should be rare enough that every
 * sentence matters. So each kind of message has its own minimum spacing, and
 * there is a cap on how much is said in any half minute.
 *
 *   stop    - "No clear way around. Stop." / head-height hazard. Always allowed
 *             (but never the same sentence twice within 4 s).
 *   steer   - "Step left." At least 5 s apart, and 2 s after anything else.
 *   resume  - "Way opened. Go ahead carefully." Only right after a stop.
 *   warn    - something approaching in your path. Needs 8 s of quiet.
 *   info    - leaves, a step, someone walking your way. Needs 20 s since the
 *             last info and 8 s of quiet.
 *
 * Anything but stop also yields when 4 things were already said in 30 s.
 */
export type TalkKind = 'stop' | 'steer' | 'resume' | 'warn' | 'info';

const GAP: Record<TalkKind, { sameKind: number; quiet: number }> = {
  stop: { sameKind: 0, quiet: 0 },
  steer: { sameKind: 5000, quiet: 2000 },
  resume: { sameKind: 0, quiet: 0 },
  warn: { sameKind: 8000, quiet: 8000 },
  info: { sameKind: 20000, quiet: 8000 },
};
const WINDOW_MS = 30000;
const WINDOW_MAX = 4;
const SAME_TEXT_MS: Record<TalkKind, number> = { stop: 4000, steer: 15000, resume: 10000, warn: 30000, info: 60000 };

export class TalkPolicy {
  private lastAny = -Infinity;
  private lastKind = new Map<TalkKind, number>();
  private lastText = new Map<string, number>();
  private recent: number[] = [];
  private lastWasStop = false;

  reset(): void {
    this.lastAny = -Infinity;
    this.lastKind.clear();
    this.lastText.clear();
    this.recent = [];
    this.lastWasStop = false;
  }

  /** True if `text` may be spoken now; if so, it is recorded as spoken. */
  allow(kind: TalkKind, text: string, now: number): boolean {
    const t = this.lastText.get(text);
    if (t !== undefined && now - t < SAME_TEXT_MS[kind]) return false;
    if (kind === 'resume' && !this.lastWasStop) return false;
    if (kind !== 'stop' && kind !== 'resume') {
      const g = GAP[kind];
      if (now - this.lastAny < g.quiet) return false;
      if (now - (this.lastKind.get(kind) ?? -Infinity) < g.sameKind) return false;
      this.recent = this.recent.filter((r) => now - r < WINDOW_MS);
      if (this.recent.length >= WINDOW_MAX) return false;
    }
    this.lastAny = now;
    this.lastKind.set(kind, now);
    this.lastText.set(text, now);
    this.recent.push(now);
    this.lastWasStop = kind === 'stop';
    return true;
  }
}
