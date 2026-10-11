/**
 * World-space guideline model (the approach of the open-source guide-line system,
 * written for the browser):
 *
 *   image keypoints --(camera pitch + height)--> ground plane (metres)
 *   --> accumulated across frames, moved by your own motion (speed, turn rate)
 *   --> RANSAC curve fit  x(z) = c0 + c1 z + c2 z^2   (x right, z ahead)
 *   --> control: lateral offset, heading, look-ahead target, turn ahead.
 *
 * Working in metres instead of pixels makes feedback independent of where the
 * phone points, and fitting across frames rides through gaps and glare.
 */

export interface GroundPoint {
  /** Metres to the right (+) or left (-) of the camera. */
  x: number;
  /** Metres ahead. */
  z: number;
}

export interface CameraModel {
  /** Image size in pixels. */
  width: number;
  height: number;
  /** Field of view along the long side, degrees. */
  fovDeg: number;
  /** How far the camera points DOWN from horizontal, radians. */
  pitch: number;
  /** Camera height above the ground, metres (chest ~1.3, waist ~1.0). */
  mountHeight: number;
}

/** Project an image pixel onto the ground plane, or null if at/above the horizon. */
export function groundPoint(u: number, v: number, cam: CameraModel): GroundPoint | null {
  const f = Math.max(cam.width, cam.height) / 2 / Math.tan((cam.fovDeg * Math.PI) / 360);
  const dx = u - cam.width / 2;
  const dy = v - cam.height / 2;
  const c = Math.cos(cam.pitch), s = Math.sin(cam.pitch);
  // Camera ray (x right, y down, z forward) rotated by the downward pitch.
  const yw = dy * c + f * s;
  const zw = -dy * s + f * c;
  if (yw <= 1e-6) return null;
  const t = cam.mountHeight / yw;
  const z = t * zw;
  if (z <= 0 || z > 40) return null;
  return { x: t * dx, z };
}

/** Image pixel for a ground point (for drawing the fitted line back on the video). */
export function imagePoint(p: GroundPoint, cam: CameraModel): { u: number; v: number } | null {
  const f = Math.max(cam.width, cam.height) / 2 / Math.tan((cam.fovDeg * Math.PI) / 360);
  const c = Math.cos(cam.pitch), s = Math.sin(cam.pitch);
  // World (x, y=height down, z) into camera coords.
  const yc = cam.mountHeight * c - p.z * s;
  const zc = cam.mountHeight * s + p.z * c;
  if (zc <= 1e-6) return null;
  return { u: cam.width / 2 + (f * p.x) / zc, v: cam.height / 2 + (f * yc) / zc };
}

export interface CurveFit {
  c0: number;
  c1: number;
  c2: number;
  inliers: number;
  /** Furthest ahead the fit is supported by points (m). */
  reach: number;
}

export const evalCurve = (k: CurveFit, z: number) => k.c0 + k.c1 * z + k.c2 * z * z;

/** Least squares for x = c0 + c1 z + c2 z^2 (falls back to a line with few points). */
export function fitQuadratic(pts: GroundPoint[]): Omit<CurveFit, 'inliers' | 'reach'> | null {
  const n = pts.length;
  if (n < 3) return null;
  let s0 = 0, s1 = 0, s2 = 0, s3 = 0, s4 = 0, t0 = 0, t1 = 0, t2 = 0;
  for (const p of pts) {
    const z = p.z, z2 = z * z;
    s0 += 1;
    s1 += z;
    s2 += z2;
    s3 += z2 * z;
    s4 += z2 * z2;
    t0 += p.x;
    t1 += p.x * z;
    t2 += p.x * z2;
  }
  // Solve the 3x3 normal equations (Cramer's rule).
  const det = (a: number[][]) =>
    a[0][0] * (a[1][1] * a[2][2] - a[1][2] * a[2][1]) -
    a[0][1] * (a[1][0] * a[2][2] - a[1][2] * a[2][0]) +
    a[0][2] * (a[1][0] * a[2][1] - a[1][1] * a[2][0]);
  const M = [
    [s0, s1, s2],
    [s1, s2, s3],
    [s2, s3, s4],
  ];
  const D = det(M);
  if (Math.abs(D) < 1e-9) {
    const den = s0 * s2 - s1 * s1;
    if (Math.abs(den) < 1e-9) return null;
    const c1 = (s0 * t1 - s1 * t0) / den;
    return { c0: (t0 - c1 * s1) / s0, c1, c2: 0 };
  }
  const col = (i: number) => M.map((r, k) => r.map((v, j) => (j === i ? [t0, t1, t2][k] : v)));
  return { c0: det(col(0)) / D, c1: det(col(1)) / D, c2: det(col(2)) / D };
}

/**
 * RANSAC: robust to stray points (other markings, a shadow edge, a shoe).
 * Deterministic pseudo-random sampling so results are repeatable.
 */
export function ransacCurve(pts: GroundPoint[], tol = 0.12, iters = 60): CurveFit | null {
  if (pts.length < 6) return null;
  let seed = 12345;
  const rnd = (n: number) => ((seed = (seed * 16807) % 2147483647) % n);
  let best: GroundPoint[] = [];
  for (let i = 0; i < iters; i++) {
    const sample = [pts[rnd(pts.length)], pts[rnd(pts.length)], pts[rnd(pts.length)]];
    const k = fitQuadratic(sample);
    if (!k || Math.abs(k.c2) > 0.08) continue; // tighter than any running-track bend
    const inl = pts.filter((p) => Math.abs(p.x - (k.c0 + k.c1 * p.z + k.c2 * p.z * p.z)) < tol);
    if (inl.length > best.length) best = inl;
  }
  if (best.length < 6) return null;
  const k = fitQuadratic(best);
  if (!k) return null;
  return { ...k, inliers: best.length, reach: Math.max(...best.map((p) => p.z)) };
}

interface MapPoint extends GroundPoint {
  t: number;
}

/**
 * Keypoints from recent frames, kept in the runner's moving frame: each
 * update moves old points back by the distance run and rotates them by the
 * turn, so they line up with new ones (multi-frame aggregation).
 */
export class GuidelineMap {
  private pts: MapPoint[] = [];

  reset(): void {
    this.pts = [];
  }

  get size(): number {
    return this.pts.length;
  }

  /** `forward` metres moved and `turn` radians turned (+ right) since the last update. */
  update(fresh: GroundPoint[], forward: number, turn: number, now: number, keepMs = 1200): void {
    const c = Math.cos(turn), s = Math.sin(turn);
    for (const p of this.pts) {
      const z = p.z - forward;
      const x = p.x;
      // Turning right rotates the world left around you.
      p.x = x * c - z * s;
      p.z = x * s + z * c;
    }
    this.pts = this.pts.filter((p) => now - p.t <= keepMs && p.z > -0.5 && p.z < 25);
    for (const p of fresh) this.pts.push({ ...p, t: now });
    if (this.pts.length > 400) this.pts.splice(0, this.pts.length - 400);
  }

  fit(tol?: number): CurveFit | null {
    return ransacCurve(this.pts, tol);
  }

  points(): readonly GroundPoint[] {
    return this.pts;
  }
}

export interface Control {
  /** Your position relative to the line/centre, metres; + = you are right of it. */
  lateral: number;
  /** Your heading relative to the line, radians; + = heading off to the right. */
  heading: number;
  /** Look-ahead target on the line, in your frame. */
  target: GroundPoint;
  /** Steering needed to reach the target, radians; + = steer right. */
  steer: number;
  /** Change of line direction over the next ~12 m, radians; + = turns right. */
  turnAhead: number;
}

/**
 * Pure-pursuit style control from the fitted line: aim at a point ahead on
 * the line (further ahead when faster), which turns small offsets into
 * gentle corrections instead of zig-zags.
 */
export function controlFrom(k: CurveFit, speed: number): Control {
  const look = Math.max(2.5, Math.min(8, speed * 1.2));
  const xt = evalCurve(k, look);
  const slope0 = k.c1;
  const slopeAhead = k.c1 + 2 * k.c2 * Math.min(12, Math.max(look, k.reach));
  return {
    lateral: -k.c0,
    heading: -Math.atan(slope0),
    target: { x: xt, z: look },
    steer: Math.atan2(xt, look),
    turnAhead: Math.atan(slopeAhead) - Math.atan(slope0),
  };
}

/**
 * Small constant-velocity Kalman filter for one value (e.g. lateral offset):
 * smooth without lag-induced overshoot, and it keeps predicting through
 * short gaps (a few frames without a line).
 */
export class Kalman1D {
  x = 0;
  v = 0;
  private P = [
    [1, 0],
    [0, 1],
  ];
  private init = false;

  constructor(
    private readonly q = 0.5,
    private readonly r = 0.02,
  ) {}

  reset(): void {
    this.init = false;
    this.x = this.v = 0;
    this.P = [
      [1, 0],
      [0, 1],
    ];
  }

  predict(dt: number): number {
    if (!this.init) return this.x;
    this.x += this.v * dt;
    const [[a, b], [c, d]] = this.P;
    const q = this.q;
    this.P = [
      [a + dt * (c + b) + dt * dt * d + (q * dt ** 4) / 4, b + dt * d + (q * dt ** 3) / 2],
      [c + dt * d + (q * dt ** 3) / 2, d + q * dt * dt],
    ];
    return this.x;
  }

  update(z: number): number {
    if (!this.init) {
      this.x = z;
      this.v = 0;
      this.init = true;
      return this.x;
    }
    const [[a, b], [c, d]] = this.P;
    const S = a + this.r;
    const k0 = a / S, k1 = c / S;
    const y = z - this.x;
    this.x += k0 * y;
    this.v += k1 * y;
    this.P = [
      [(1 - k0) * a, (1 - k0) * b],
      [c - k1 * a, d - k1 * b],
    ];
    return this.x;
  }
}
