/**
 * Run coaching for blind athletes: short spoken facts at the right moments,
 * never a stream of chatter. Pure and clock-driven so it is testable.
 */

const sayDur = (s: number) => {
  s = Math.round(Math.abs(s));
  const m = Math.floor(s / 60), r = s % 60;
  if (m === 0) return `${r} second${r === 1 ? '' : 's'}`;
  return `${m} ${m === 1 ? 'minute' : 'minutes'}${r ? ` ${r}` : ''}`;
};

/** Lap splits, compared with the previous lap: "Lap 3, 1 minute 52, 3 seconds faster." */
export class LapTimer {
  private laps = 0;
  private lastLapAt = 0;
  private prevSplit: number | null = null;
  best: number | null = null;

  reset(): void {
    this.laps = 0;
    this.lastLapAt = 0;
    this.prevSplit = null;
    this.best = null;
  }

  /** Returns the announcement when a new lap completes. */
  update(laps: number, elapsedS: number): string | null {
    if (laps <= this.laps) return null;
    const split = (elapsedS - this.lastLapAt) / Math.max(1, laps - this.laps);
    this.laps = laps;
    this.lastLapAt = elapsedS;
    let cmp = '';
    if (this.prevSplit !== null) {
      const d = split - this.prevSplit;
      cmp = Math.abs(d) < 1 ? ' Same as last lap.' : ` ${sayDur(d)} ${d < 0 ? 'faster' : 'slower'}.`;
    }
    this.prevSplit = split;
    if (this.best === null || split < this.best) this.best = split;
    return `Lap ${laps}, ${sayDur(split)}.${cmp}`;
  }
}

/**
 * Pace coach: compares live pace with a target (seconds per km) and speaks
 * only when off by more than 3 %, at most every 30 s. Silent when on pace.
 */
export class PaceCoach {
  private lastSaid = -Infinity;

  reset(): void {
    this.lastSaid = -Infinity;
  }

  update(paceS: number, targetS: number, nowS: number): string | null {
    if (!targetS || !Number.isFinite(paceS) || paceS > 1800) return null;
    if (nowS - this.lastSaid < 30) return null;
    const off = (paceS - targetS) / targetS;
    if (Math.abs(off) <= 0.03) return null;
    this.lastSaid = nowS;
    const secs = Math.round(Math.abs(paceS - targetS));
    return off > 0 ? `${secs} seconds per kilometre slow. Pick it up a little.` : `${secs} seconds per kilometre fast. Ease off a little.`;
  }
}

/** Heart-rate zone 1-5 as a percentage of maximum heart rate (50/60/70/80/90 %). */
export function hrZone(bpm: number, max: number): number {
  const p = bpm / max;
  if (p < 0.6) return 1;
  if (p < 0.7) return 2;
  if (p < 0.8) return 3;
  if (p < 0.9) return 4;
  return 5;
}

/** Announces zone changes once they have held for 15 s (no flicker at a boundary). */
export class ZoneWatcher {
  private zone = 0;
  private candidate = 0;
  private since = 0;

  reset(): void {
    this.zone = this.candidate = 0;
  }

  update(bpm: number | null, max: number, nowS: number): string | null {
    if (!bpm || !max) return null;
    const z = hrZone(bpm, max);
    if (z !== this.candidate) {
      this.candidate = z;
      this.since = nowS;
    }
    if (z !== this.zone && nowS - this.since >= 15) {
      const up = z > this.zone;
      const first = this.zone === 0;
      this.zone = z;
      if (first) return null; // don't announce the starting zone
      return `Heart rate zone ${z}${up ? ', going up' : ''}. ${bpm} beats.`;
    }
    return null;
  }
}

/**
 * STOP guard (after Google's Project Guideline): if the line is lost while
 * moving, or the runner has left the lane/line entirely, signal STOP, and
 * keep repeating it until the line is found again - then say "go".
 */
export class StopGuard {
  stopped = false;
  private lostSince: number | null = null;
  private lastStopCue = -Infinity;

  reset(): void {
    this.stopped = false;
    this.lostSince = null;
    this.lastStopCue = -Infinity;
  }

  /**
   * @returns 'stop' to play/repeat the STOP cue now, 'go' once when guidance is
   * back, or null.
   */
  update(lost: boolean, offset: number, moving: boolean, nowMs: number): 'stop' | 'go' | null {
    if (lost) this.lostSince ??= nowMs;
    else this.lostSince = null;
    const lostTooLong = this.lostSince !== null && nowMs - this.lostSince > 1500 && moving;
    const outOfLane = !lost && Math.abs(offset) > 0.6;
    if (lostTooLong || outOfLane) {
      const first = !this.stopped;
      this.stopped = true;
      if (first || nowMs - this.lastStopCue > 3000) {
        this.lastStopCue = nowMs;
        return 'stop';
      }
      return null;
    }
    if (this.stopped && !lost && Math.abs(offset) < 0.4) {
      this.stopped = false;
      return 'go';
    }
    return null;
  }
}
