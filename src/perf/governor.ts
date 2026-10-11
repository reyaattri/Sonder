import type { ModelId } from '../core/types';

export interface QualityLevel {
  model: ModelId;
  /** Width of the frame handed to the detector (height follows aspect). */
  inputWidth: number;
}

/**
 * Step-down ladder for the chosen model: lower input resolution first, then
 * a smaller model (US-4.3).
 */
export function qualityLadder(model: ModelId): QualityLevel[] {
  const levels: QualityLevel[] = [640, 480, 320].map((inputWidth) => ({ model, inputWidth }));
  if (model !== 'efficientdet_lite0') {
    levels.push({ model: 'efficientdet_lite0', inputWidth: 480 }, { model: 'efficientdet_lite0', inputWidth: 320 });
  }
  return levels;
}

const LOW_FPS = 12;
const LOW_FOR_MS = 3000;
const HIGH_FPS = 20;
const HIGH_FOR_MS = 10000;

export type GovernorEvent = { kind: 'down' | 'up'; level: QualityLevel; firstDown: boolean } | null;

/**
 * If FPS stays below 12 for 3 s, step down one level; step back up after
 * 10 s of comfortably high FPS. The user is told only on the first step-down.
 */
export class QualityGovernor {
  private idx = 0;
  private lowSince: number | null = null;
  private highSince: number | null = null;
  private toldUser = false;
  /** Never step back up past this level (set when a model proved too slow). */
  private floor = 0;

  constructor(private levels: QualityLevel[]) {}

  get level(): QualityLevel {
    return this.levels[this.idx];
  }

  reset(levels: QualityLevel[]): void {
    this.levels = levels;
    this.idx = 0;
    this.floor = 0;
    this.lowSince = this.highSince = null;
  }

  /** Jump to the first level that uses `model` (e.g. skip straight to the fast model). */
  jumpTo(model: QualityLevel['model']): void {
    const i = this.levels.findIndex((l, k) => k > this.idx && l.model === model);
    if (i >= 0) this.idx = this.floor = i;
  }

  /** Call once per processed frame with the current measured FPS. */
  update(fps: number, now: number): GovernorEvent {
    if (fps < LOW_FPS) {
      this.highSince = null;
      this.lowSince ??= now;
      if (now - this.lowSince >= LOW_FOR_MS && this.idx < this.levels.length - 1) {
        this.idx++;
        this.lowSince = now; // give the new level a fresh 3 s
        const firstDown = !this.toldUser;
        this.toldUser = true;
        return { kind: 'down', level: this.level, firstDown };
      }
    } else if (fps >= HIGH_FPS) {
      this.lowSince = null;
      this.highSince ??= now;
      if (now - this.highSince >= HIGH_FOR_MS && this.idx > this.floor) {
        this.idx--;
        this.highSince = now;
        return { kind: 'up', level: this.level, firstDown: false };
      }
    } else {
      this.lowSince = this.highSince = null;
    }
    return null;
  }
}
