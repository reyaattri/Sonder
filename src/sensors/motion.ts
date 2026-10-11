/**
 * Body-worn motion sensing from the phone's accelerometer:
 * - walking detection and speed (step cadence x step length), so static
 *   obstacles get a time-to-contact while the wearer walks toward them
 *   (the "compare against my own motion" stretch goal in US-6.2);
 * - camera tilt (elevation of the camera axis above the horizon), so a
 *   chest/waist mount pointing at the floor or sky can be corrected.
 */

/** Camera elevation in degrees from gravity in device coordinates.
 *  `up` is accelerationIncludingGravity normalised to Android's convention
 *  (points UP when still). The rear camera looks along -z. */
export function cameraElevationDeg(up: { x: number; y: number; z: number }): number {
  const n = Math.hypot(up.x, up.y, up.z);
  if (n < 1e-6) return 0;
  return (Math.asin(Math.max(-1, Math.min(1, -up.z / n))) * 180) / Math.PI;
}

export interface StepState {
  /** Steps per minute over the recent window (0 when standing). */
  cadence: number;
  walking: boolean;
  /** Metres per second (rough: cadence x step length). */
  speed: number;
}

const STEP_THRESHOLD = 1.2; // m/s^2 above the running mean
const MIN_STEP_GAP_MS = 280; // faster than ~3.5 steps/s is not walking
const WINDOW_MS = 4000;
const STEP_LENGTH_M = 0.65;

/**
 * Peak-picking step detector on the magnitude of acceleration (gravity
 * removed by a slow running mean). Pure and clock-driven, so it is testable.
 */
export class StepDetector {
  private mean = 9.81;
  private above = false;
  private peak = 0;
  private lastStep = -Infinity;
  private steps: number[] = [];
  /** All steps since creation (for step-based distance). */
  total = 0;

  push(magnitude: number, t: number): void {
    this.mean += 0.02 * (magnitude - this.mean);
    const d = magnitude - this.mean;
    if (d > STEP_THRESHOLD) {
      this.above = true;
      this.peak = Math.max(this.peak, d);
    } else if (this.above && d < STEP_THRESHOLD * 0.3) {
      this.above = false;
      this.peak = 0;
      if (t - this.lastStep >= MIN_STEP_GAP_MS) {
        this.lastStep = t;
        this.steps.push(t);
        this.total++;
      }
    }
    while (this.steps.length && t - this.steps[0] > WINDOW_MS) this.steps.shift();
  }

  state(t: number): StepState {
    const recent = this.steps.filter((s) => t - s <= WINDOW_MS);
    const walking = recent.length >= 3 && t - recent[recent.length - 1] < 1500;
    if (!walking) return { cadence: 0, walking: false, speed: 0 };
    const span = (recent[recent.length - 1] - recent[0]) / 1000;
    const cadence = span > 0 ? ((recent.length - 1) / span) * 60 : 0;
    return { cadence, walking: cadence >= 50, speed: cadence >= 50 ? (cadence / 60) * STEP_LENGTH_M : 0 };
  }
}

export interface MotionSnapshot extends StepState {
  /** Camera elevation in degrees (+ up, - down); NaN if unknown. */
  elevation: number;
  available: boolean;
}

/** Wires the browser's devicemotion events to the step detector and tilt estimate. */
export class MotionSensor {
  available = false;
  private steps = new StepDetector();
  private gravity = { x: 0, y: 0, z: 0 };
  private hasGravity = false;
  private readonly invert = /iPad|iPhone|iPod/.test(navigator.userAgent); // iOS reports the opposite sign
  private listening = false;

  /** iOS needs permission from a tap. Call from the Start button handler. */
  async start(): Promise<boolean> {
    if (this.listening) return this.available;
    const DME = (window as { DeviceMotionEvent?: typeof DeviceMotionEvent & { requestPermission?: () => Promise<string> } })
      .DeviceMotionEvent;
    if (!DME) return false;
    try {
      if (typeof DME.requestPermission === 'function' && (await DME.requestPermission()) !== 'granted') return false;
    } catch {
      return false;
    }
    window.addEventListener('devicemotion', this.onMotion);
    this.listening = true;
    return true;
  }

  stop(): void {
    window.removeEventListener('devicemotion', this.onMotion);
    this.listening = false;
  }

  get totalSteps(): number {
    return this.steps.total;
  }

  snapshot(t = performance.now()): MotionSnapshot {
    const s = this.steps.state(t);
    return {
      ...s,
      elevation: this.hasGravity ? cameraElevationDeg(this.gravity) : NaN,
      available: this.available,
    };
  }

  private onMotion = (e: DeviceMotionEvent): void => {
    const a = e.accelerationIncludingGravity;
    if (!a || a.x === null || a.y === null || a.z === null) return;
    this.available = true;
    const k = this.invert ? -1 : 1;
    const x = a.x * k, y = a.y * k, z = a.z * k;
    // Low-pass for the gravity direction (tilt)
    const lp = this.hasGravity ? 0.08 : 1;
    this.gravity.x += lp * (x - this.gravity.x);
    this.gravity.y += lp * (y - this.gravity.y);
    this.gravity.z += lp * (z - this.gravity.z);
    this.hasGravity = true;
    this.steps.push(Math.hypot(x, y, z), e.timeStamp || performance.now());
  };
}
