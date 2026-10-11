import type { Verbosity, Zone } from '../core/types';
import { classInfo } from '../perception/classes';
import type { Track } from '../perception/tracker';

export interface Warning {
  trackId: number;
  text: string;
  /** Lower = more urgent (seconds to contact). */
  ttc: number;
}

const WORDS = ['zero', 'one', 'two', 'three', 'four', 'five'];
const MIN_SCORE = 0.6;
const MIN_HITS = 5;
const SPEAK_TTC_S = 3;
const URGENT_TTC_S = 2.5;
const REPEAT_MS = 6000;

export function phrase(label: string, zone: Zone, ttc: number): string {
  const name = classInfo(label)?.spoken ?? label;
  const secs = Math.max(1, Math.round(ttc));
  const n = WORDS[secs] ?? String(secs);
  return `${name}, ${zone}, about ${n} second${secs === 1 ? '' : 's'}`;
}

/**
 * Picks approaching objects worth a spoken warning (US-6.1, US-6.4):
 * time-to-contact under 4 s with high confidence, filtered by verbosity,
 * at most once per object every few seconds. Most urgent first.
 */
export class WarningPolicy {
  private lastSpoken = new Map<number, number>();

  reset(): void {
    this.lastSpoken.clear();
  }

  update(tracks: readonly Track[], now: number, verbosity: Verbosity): Warning[] {
    if (verbosity === 'off') return [];
    const out: Warning[] = [];
    for (const t of tracks) {
      if (!t.confirmed || t.hits < MIN_HITS || t.score < MIN_SCORE) continue;
      if (!(t.ttc < SPEAK_TTC_S)) continue;
      // Things beside your path are heard, not spoken about; vehicles always count.
      if (t.zone !== 'center' && t.category !== 'vehicle') continue;
      // One warning per object.
      if (this.lastSpoken.has(t.id)) continue;
      if (verbosity === 'urgent' && !(t.ttc < URGENT_TTC_S || t.band === 'veryNear')) continue;
      const last = this.lastSpoken.get(t.id);
      if (last !== undefined && now - last < REPEAT_MS) continue;
      out.push({ trackId: t.id, text: phrase(t.label, t.zone, t.ttc), ttc: t.ttc });
    }
    return out.sort((a, b) => a.ttc - b.ttc);
  }

  markSpoken(trackId: number, now: number): void {
    this.lastSpoken.set(trackId, now);
  }
}
