/**
 * Running-track lane detection: classic computer vision on a small frame
 * (e.g. 160x120), fast enough to run on every camera frame on the main
 * thread (a few ms), so lane feedback isn't limited by the object detector.
 *
 * 1. Paint mask: pixels much brighter than their row (adaptive to sun and
 *    shade) and low in saturation (white lane paint on red/blue/green tracks).
 * 2. Candidate points: centres of short bright runs in each row of the
 *    ground region (lower part of the frame).
 * 3. Hough vote over lines x = a*y + b (near-vertical in the image).
 * 4. Least-squares refinement per line on its inliers.
 * 5. Lane = nearest line left of centre + nearest line right of centre at the
 *    bottom row. Offset and heading follow from their positions.
 *
 * Course types: 'lanes' (two boundaries, running track), 'line' (run along a
 * single painted guide line, as in the open-source guide-line system, or a road
 * race's painted racing line) and 'edge' (keep a kerb/edge line on one side).
 * Paint colour: white, yellow, blue or any bright marking. Curvature of the
 * lines ahead gives early warning of bends.
 */

export type CourseMode = 'lanes' | 'line' | 'edge';
export type LineColor = 'white' | 'yellow' | 'blue' | 'any';

/** x = a*y + b in frame pixels. */
export interface LineFit {
  a: number;
  b: number;
  support: number;
}

export interface LaneMeasurement {
  left: LineFit | null;
  right: LineFit | null;
  /** Lateral position in the lane: -0.5 = on the left line, 0 = centred, +0.5 = on the right line. */
  offset: number | null;
  /** Radians; + = heading toward the right line. Null with fewer than two lines. */
  heading: number | null;
  /** Lane width at the bottom row, pixels. */
  widthPx: number | null;
  /** 0..1 */
  confidence: number;
  /** + = the lines ahead bend right, - = left (difference of near/far slopes). Null if unknown. */
  curvature: number | null;
  /** Image points along each detected line (following curves), for the world-space map. */
  keypoints: { left: { x: number; y: number }[]; right: { x: number; y: number }[] };
  /** For drawing/debug. */
  points: number;
  width: number;
  height: number;
}

export interface LaneOptions {
  /** Top of the ground region as a fraction of height (rows above are ignored). */
  roiTop: number;
  /** Remembered lane width (px at bottom row), used when only one line is visible. */
  expectedWidthPx?: number | null;
  mode?: CourseMode;
  color?: LineColor;
  /** 'edge' mode: which side the kerb/edge line should be on. */
  edgeSide?: 'left' | 'right';
  /** 'line'/'edge' mode: where the line was last seen at the bottom row (px), to keep locked on it. */
  expectedX?: number | null;
}

/** Where an edge line should sit: 30 % of the frame width to that side of centre. */
export const EDGE_TARGET = 0.3;

function hueOf(r: number, g: number, b: number): number {
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  if (d === 0) return 0;
  let h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  h *= 60;
  return h < 0 ? h + 360 : h;
}

const SLOPES = 61; // a in [-3, 3]
const A_MAX = 3;

export function paintMask(rgba: Uint8ClampedArray, w: number, h: number, roiTop: number, color: LineColor = 'white'): Uint8Array {
  const mask = new Uint8Array(w * h);
  const y0 = Math.floor(h * roiTop);
  const luma = new Float32Array(w);
  for (let y = y0; y < h; y++) {
    let sum = 0, sum2 = 0;
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const l = 0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2];
      luma[x] = l;
      sum += l;
      sum2 += l * l;
    }
    const mean = sum / w;
    const std = Math.sqrt(Math.max(0, sum2 / w - mean * mean));
    const thr = mean + Math.max(28, 1.1 * std);
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const r = rgba[i], g = rgba[i + 1], b = rgba[i + 2];
      const max = Math.max(r, g, b);
      const sat = max - Math.min(r, g, b);
      const satRel = max ? sat / max : 0;
      let on = false;
      if (color === 'white' || color === 'any') on = luma[x] >= thr && sat < 80;
      if (!on && (color === 'yellow' || color === 'any')) {
        const hue = hueOf(r, g, b);
        on = hue >= 35 && hue <= 70 && satRel > 0.35 && luma[x] > mean * 0.9;
      }
      if (!on && (color === 'blue' || color === 'any')) {
        const hue = hueOf(r, g, b);
        on = hue >= 190 && hue <= 250 && satRel > 0.3 && b > 60;
      }
      if (on) mask[y * w + x] = 1;
    }
  }
  return mask;
}

/** Centres of short bright runs per row (a lane line crosses each row once). */
export function candidatePoints(mask: Uint8Array, w: number, h: number, roiTop: number): { x: number; y: number }[] {
  const pts: { x: number; y: number }[] = [];
  const y0 = Math.floor(h * roiTop);
  // Near the camera a painted line can be wide in pixels; allow up to 16 % of the width.
  const maxRun = Math.max(3, Math.round(w * 0.16));
  for (let y = y0; y < h; y++) {
    let x = 0;
    while (x < w) {
      if (!mask[y * w + x]) {
        x++;
        continue;
      }
      const start = x;
      while (x < w && mask[y * w + x]) x++;
      const len = x - start;
      if (len <= maxRun) pts.push({ x: start + (len - 1) / 2, y });
    }
  }
  return pts;
}

function fitLine(pts: { x: number; y: number }[]): { a: number; b: number } | null {
  const n = pts.length;
  if (n < 2) return null;
  let sy = 0, sx = 0, syy = 0, sxy = 0;
  for (const p of pts) {
    sy += p.y;
    sx += p.x;
    syy += p.y * p.y;
    sxy += p.x * p.y;
  }
  const den = n * syy - sy * sy;
  if (Math.abs(den) < 1e-9) return null;
  const a = (n * sxy - sx * sy) / den;
  return { a, b: (sx - a * sy) / n };
}

/** Hough over (slope, bottom intercept), then least-squares refine. */
export function findLines(pts: { x: number; y: number }[], w: number, h: number, roiTop: number): LineFit[] {
  const yb = h - 1;
  const xbMin = -w, xbMax = 2 * w;
  const bins = Math.ceil((xbMax - xbMin) / 2);
  const acc = new Uint16Array(SLOPES * bins);
  const slopeOf = (k: number) => -A_MAX + (2 * A_MAX * k) / (SLOPES - 1);
  for (const p of pts) {
    for (let k = 0; k < SLOPES; k++) {
      const xb = p.x + slopeOf(k) * (yb - p.y);
      const j = Math.floor((xb - xbMin) / 2);
      if (j >= 0 && j < bins) acc[k * bins + j]++;
    }
  }
  const roiRows = h - Math.floor(h * roiTop);
  const minVotes = Math.max(6, Math.round(roiRows * 0.25));
  const lines: LineFit[] = [];
  const used = new Uint8Array(acc.length);
  for (let iter = 0; iter < 6; iter++) {
    let best = -1, bestV = minVotes - 1;
    for (let i = 0; i < acc.length; i++) if (!used[i] && acc[i] > bestV) [best, bestV] = [i, acc[i]];
    if (best < 0) break;
    const k = Math.floor(best / bins), j = best % bins;
    const a0 = slopeOf(k), xb0 = xbMin + j * 2 + 1;
    // Suppress neighbours of this peak (same physical line).
    const sup = Math.max(3, Math.round((w * 0.05) / 2));
    for (let kk = Math.max(0, k - 6); kk <= Math.min(SLOPES - 1, k + 6); kk++)
      for (let jj = Math.max(0, j - sup); jj <= Math.min(bins - 1, j + sup); jj++) used[kk * bins + jj] = 1;
    // Refine on inliers
    const inl = pts.filter((p) => Math.abs(p.x - (a0 * (p.y - yb) + xb0)) < 2.5);
    const span = inl.length ? Math.max(...inl.map((p) => p.y)) - Math.min(...inl.map((p) => p.y)) : 0;
    if (inl.length < minVotes || span < roiRows * 0.3) continue;
    const f = fitLine(inl);
    if (!f) continue;
    if (lines.some((l) => Math.abs(l.a * yb + l.b - (f.a * yb + f.b)) < w * 0.05)) continue;
    lines.push({ ...f, support: inl.length });
  }
  return lines;
}

const xAt = (l: LineFit, y: number) => l.a * y + l.b;

export function measureLane(rgba: Uint8ClampedArray, w: number, h: number, opts: LaneOptions): LaneMeasurement {
  const mask = paintMask(rgba, w, h, opts.roiTop, opts.color ?? 'white');
  const pts = candidatePoints(mask, w, h, opts.roiTop);
  const lines = findLines(pts, w, h, opts.roiTop);
  const yb = h - 1, cx = (w - 1) / 2;
  const roiRows = h - Math.floor(h * opts.roiTop);
  const mode = opts.mode ?? 'lanes';
  if (mode !== 'lanes') return measureSingleLine(lines, pts, w, h, opts, mode);

  // Perspective: the left boundary leans right going up (a < 0), the right
  // boundary leans left (a > 0). Allow some tolerance for heading.
  const lefts = lines.filter((l) => xAt(l, yb) < cx && l.a < 0.6);
  const rights = lines.filter((l) => xAt(l, yb) >= cx && l.a > -0.6);
  let left: LineFit | null = null, right: LineFit | null = null;
  for (const l of lefts) if (!left || xAt(l, yb) > xAt(left, yb)) left = l;
  for (const r of rights) if (!right || xAt(r, yb) < xAt(right, yb)) right = r;
  // With a remembered lane width, prefer the pair that matches it: another
  // runner's legs or a shadow edge can look like a closer "line".
  const W0 = opts.expectedWidthPx;
  if (W0 && lefts.length && rights.length) {
    let best: [LineFit, LineFit] | null = null, bestErr = Infinity;
    for (const l of lefts)
      for (const r of rights) {
        const err = Math.abs(xAt(r, yb) - xAt(l, yb) - W0) / W0;
        if (err < bestErr) [best, bestErr] = [[l, r], err];
      }
    if (best && bestErr < 0.3) [left, right] = best;
    else if (left && right && Math.abs(xAt(right, yb) - xAt(left, yb) - W0) / W0 > 0.45) {
      // Nothing matches: trust only the side that agrees with the remembered centre.
      right = null;
    }
  }

  let offset: number | null = null, heading: number | null = null, widthPx: number | null = null;
  if (left && right) {
    const xl = xAt(left, yb), xr = xAt(right, yb);
    widthPx = xr - xl;
    if (widthPx > w * 0.08) {
      offset = (cx - (xl + xr) / 2) / widthPx;
      // Vanishing point: where the two boundaries meet.
      const da = left.a - right.a;
      if (Math.abs(da) > 1e-6) {
        const yv = (right.b - left.b) / da;
        const xv = xAt(left, yv);
        const f = w / 2 / Math.tan((65 * Math.PI) / 360); // nominal focal length at this frame width
        heading = Math.atan((cx - xv) / f);
      }
    } else {
      widthPx = null;
    }
  } else if ((left || right) && opts.expectedWidthPx) {
    const W = opts.expectedWidthPx;
    const centre = left ? xAt(left, yb) + W / 2 : xAt(right!, yb) - W / 2;
    offset = (cx - centre) / W;
  }

  const support = (left?.support ?? 0) + (right?.support ?? 0);
  const base = left && right ? 1 : left || right ? 0.55 : 0;
  const confidence = offset === null ? 0 : base * Math.min(1, support / (roiRows * 1.2));
  const ks = [left, right].filter((l): l is LineFit => !!l).map((l) => curvatureOf(l, pts, h, opts.roiTop)).filter((k): k is number => k !== null);
  const curvature = ks.length ? ks.reduce((a, b) => a + b, 0) / ks.length : null;
  const keypoints = {
    left: left ? followLine(left, pts, h, opts.roiTop) : [],
    right: right ? followLine(right, pts, h, opts.roiTop) : [],
  };
  return { left, right, offset, heading, widthPx, confidence, curvature, keypoints, points: pts.length, width: w, height: h };
}

/**
 * Bend ahead from one line: fit its near and far halves separately.
 * x = a*y + b, so a line curving right further away has a smaller (more
 * negative) slope in its far half: curvature = a_near - a_far (+ = right).
 */
export function curvatureOf(l: LineFit, pts: { x: number; y: number }[], h: number, roiTop: number): number | null {
  const y0 = Math.floor(h * roiTop), yMid = (y0 + h) / 2;
  const all = followLine(l, pts, h, roiTop);
  const near = all.filter((p) => p.y >= yMid);
  const far = all.filter((p) => p.y < yMid);
  const nf = fitLine(near), ff = fitLine(far);
  if (!nf || !ff || near.length < 4 || far.length < 4) return null;
  return nf.a - ff.a;
}

/**
 * Points belonging to one painted line, bottom to top. The near half sticks
 * to the straight fit; further up it follows the line as it curves away,
 * re-centring on each row (a curve leaves the straight fit far away).
 */
export function followLine(l: LineFit, pts: { x: number; y: number }[], h: number, roiTop: number): { x: number; y: number }[] {
  const y0 = Math.floor(h * roiTop), yMid = (y0 + h) / 2;
  const near = pts.filter((p) => p.y >= yMid && Math.abs(p.x - (l.a * p.y + l.b)) < 4);
  const nf = fitLine(near);
  if (!nf || near.length < 4) return near;
  const far: { x: number; y: number }[] = [];
  let expectA = nf.a, expectB = nf.b;
  for (let y = Math.floor(yMid) - 1; y >= y0; y--) {
    const want = expectA * y + expectB;
    const row = pts.filter((p) => p.y === y && Math.abs(p.x - want) < 6);
    if (!row.length) continue;
    const best = row.reduce((a, b) => (Math.abs(a.x - want) < Math.abs(b.x - want) ? a : b));
    far.push(best);
    if (far.length >= 3) {
      const ff = fitLine(far);
      if (ff) [expectA, expectB] = [ff.a, ff.b];
    }
  }
  return [...near, ...far];
}

/** 'line' / 'edge' course: one painted line, kept under you or at a set side. */
function measureSingleLine(
  lines: LineFit[],
  pts: { x: number; y: number }[],
  w: number,
  h: number,
  opts: LaneOptions,
  mode: 'line' | 'edge',
): LaneMeasurement {
  const yb = h - 1, cx = (w - 1) / 2;
  const roiRows = h - Math.floor(h * opts.roiTop);
  const sideSign = opts.edgeSide === 'right' ? 1 : -1;
  const target = mode === 'line' ? cx : cx + sideSign * EDGE_TARGET * w;
  const expect = opts.expectedX ?? target;
  const pick = (want: number, window: number) => {
    let b: LineFit | null = null, bd = Infinity;
    for (const l of lines) {
      if (Math.abs(l.a) > 2.5) continue;
      const d = Math.abs(l.a * yb + l.b - want);
      if (d < bd && d < window) [b, bd] = [l, d];
    }
    return b;
  };
  // Stay locked on the line we were following; if it's gone from there,
  // search afresh across most of the view (a line 1.5 m to the side still counts).
  let best = pick(expect, w * 0.35);
  if (!best) best = pick(target, w * 1.2);
  const base = { left: null, right: null, widthPx: null, points: pts.length, width: w, height: h };
  if (!best) return { ...base, offset: null, heading: null, confidence: 0, curvature: null, keypoints: { left: [], right: [] } };
  const xb = best.a * yb + best.b;
  // Runner right of where the line should be -> line appears further left -> +offset.
  const offset = (target - xb) / (w * 0.5);
  // Heading: where the line is far ahead vs where perspective alone would put it.
  const yv = h * 0.3, yt = Math.floor(h * opts.roiTop);
  const xFar = best.a * yt + best.b;
  const xFarExpected = cx + (xb - cx) * ((yt - yv) / (yb - yv));
  const f = w / 2 / Math.tan((65 * Math.PI) / 360);
  const heading = Math.atan((xFarExpected - xFar) / f);
  const confidence = Math.min(1, best.support / (roiRows * 0.7));
  const side = { left: xb < cx ? best : null, right: xb >= cx ? best : null };
  const kp = followLine(best, pts, h, opts.roiTop);
  return {
    ...base,
    ...side,
    offset,
    heading,
    confidence,
    curvature: curvatureOf(best, pts, h, opts.roiTop),
    keypoints: { left: xb < cx ? kp : [], right: xb >= cx ? kp : [] },
  };
}

/**
 * Temporal smoothing across frames: steadier offset/heading, remembered lane
 * width (for one-line frames), and a "lost" state when no lines for a while.
 */
export class LaneTracker {
  offset = 0;
  heading = 0;
  /** Smoothed curvature of the lines ahead (+ right). */
  curvature = 0;
  private bendState: 'left' | 'right' | null = null;
  /** Bottom-row x of the tracked line (single-line courses), to stay locked on it. */
  lineX: number | null = null;
  widthPx: number | null = null;
  confidence = 0;
  lastGood = -Infinity;
  private started = false;
  private rejected = 0;

  reset(): void {
    this.started = false;
    this.curvature = 0;
    this.bendState = null;
    this.lineX = null;
    this.widthPx = null;
    this.confidence = 0;
    this.lastGood = -Infinity;
  }

  update(m: LaneMeasurement, t: number): void {
    if (m.offset === null || m.confidence < 0.15) {
      this.confidence *= 0.85;
      return;
    }
    // One-frame jumps of more than a third of the lane are almost always a
    // false line; accept them only if they persist (a real jump).
    if (this.started && Math.abs(m.offset - this.offset) > 0.33 && this.rejected < 4) {
      this.rejected++;
      return;
    }
    this.rejected = 0;
    const a = this.started ? 0.45 : 1;
    this.offset += a * (m.offset - this.offset);
    if (m.heading !== null) this.heading += (this.started ? 0.3 : 1) * (m.heading - this.heading);
    if (m.widthPx) this.widthPx = this.widthPx ? this.widthPx + 0.1 * (m.widthPx - this.widthPx) : m.widthPx;
    if (m.curvature !== null) this.curvature += 0.3 * (m.curvature - this.curvature);
    const line = m.left ?? m.right;
    if (line && !(m.left && m.right)) this.lineX = line.a * (m.height - 1) + line.b;
    this.confidence = this.confidence + 0.4 * (m.confidence - this.confidence);
    this.lastGood = t;
    this.started = true;
  }

  /** A bend ahead, with hysteresis (enter above 0.25, leave below 0.1). */
  bend(): 'left' | 'right' | null {
    const k = this.curvature;
    if (this.bendState && Math.abs(k) < 0.1) this.bendState = null;
    else if (!this.bendState && Math.abs(k) > 0.25) this.bendState = k > 0 ? 'right' : 'left';
    return this.bendState;
  }

  lost(t: number, afterMs = 600): boolean {
    return t - this.lastGood > afterMs;
  }

  /**
   * Where you'll be in the lane after `lookaheadS` at `speed` m/s, assuming a
   * 1.22 m lane (World Athletics standard). Lets cues fire before you reach the line.
   */
  predicted(speed: number, lookaheadS = 0.35, laneM = 1.22): number {
    return this.offset + (Math.sin(this.heading) * speed * lookaheadS) / laneM;
  }
}
