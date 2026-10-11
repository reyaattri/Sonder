/**
 * Lane-keeping feedback: turns the runner's (predicted) lane position into
 * side-coded pings and vibrations. Silent while centred, so the runner hears
 * the world, not the app. Faster and higher as they drift toward a line.
 */
export type DriftLevel = 'centred' | 'drift' | 'strong' | 'danger' | 'lost';

export interface FeedbackConfig {
  /** |offset| below this is silent (fraction of lane width). */
  deadband: number;
  /** 'line': cue from the line you're drifting onto. 'steer': from the side to move toward. */
  cueSide: 'line' | 'steer';
}

export interface FeedbackEvent {
  /** Play a lane ping now. */
  ping: boolean;
  /** -1 = left ear, +1 = right ear. */
  pan: number;
  /** 0..1 */
  intensity: number;
  level: DriftLevel;
  /** Vibration pattern to fire now (ms on/off), if any. */
  vibrate: number[] | null;
  /** One-off "back in the lane" confirmation after a drift. */
  recovered: boolean;
}

const INTERVAL: Record<Exclude<DriftLevel, 'centred' | 'lost'>, number> = { drift: 450, strong: 220, danger: 110 };
const HAPTIC_GAP_MS = 600;

export function driftLevel(absOffset: number, deadband: number): Exclude<DriftLevel, 'lost'> {
  if (absOffset < deadband) return 'centred';
  if (absOffset < 0.25) return 'drift';
  if (absOffset < 0.4) return 'strong';
  return 'danger';
}

/**
 * Side coding for one phone on the chest (it can't buzz one side of the
 * body): LEFT = one pulse, RIGHT = two pulses; longer pulses when stronger.
 */
export function hapticPattern(side: -1 | 1, level: DriftLevel): number[] {
  const on = level === 'drift' ? 25 : level === 'strong' ? 45 : 80;
  return side < 0 ? [on] : [on, 70, on];
}

export class LaneFeedback {
  private lastPing = -Infinity;
  private lastHaptic = -Infinity;
  private lastLevel: DriftLevel = 'centred';
  private wasDrifting = false;

  reset(): void {
    this.lastPing = this.lastHaptic = -Infinity;
    this.lastLevel = 'centred';
    this.wasDrifting = false;
  }

  update(predictedOffset: number, lost: boolean, now: number, cfg: FeedbackConfig): FeedbackEvent {
    const none: FeedbackEvent = { ping: false, pan: 0, intensity: 0, level: 'centred', vibrate: null, recovered: false };
    if (lost) {
      this.lastLevel = 'lost';
      return { ...none, level: 'lost' };
    }
    const level = driftLevel(Math.abs(predictedOffset), cfg.deadband);
    if (level === 'centred') {
      const recovered = this.wasDrifting && this.lastLevel !== 'centred';
      this.wasDrifting = false;
      this.lastLevel = level;
      return { ...none, recovered };
    }
    this.wasDrifting = true;
    const lineSide: -1 | 1 = predictedOffset > 0 ? 1 : -1;
    const side: -1 | 1 = cfg.cueSide === 'line' ? lineSide : (-lineSide as -1 | 1);
    const intensity = Math.min(1, (Math.abs(predictedOffset) - cfg.deadband) / (0.45 - cfg.deadband));
    const escalated = level !== this.lastLevel;
    const ping = escalated || now - this.lastPing >= INTERVAL[level as keyof typeof INTERVAL];
    if (ping) this.lastPing = now;
    let vibrate: number[] | null = null;
    if (escalated || now - this.lastHaptic >= HAPTIC_GAP_MS) {
      vibrate = hapticPattern(side, level);
      this.lastHaptic = now;
    }
    this.lastLevel = level;
    return { ping, pan: side, intensity, level, vibrate, recovered: false };
  }
}
