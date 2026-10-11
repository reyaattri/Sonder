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
 */

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
}

const SLOPES = 61; // a in [-3, 3]
const A_MAX = 3;

export function paintMask(rgba: Uint8ClampedArray, w: number, h: number, roiTop: number): Uint8Array {
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
      if (luma[x] < thr) continue;
      const i = (y * w + x) * 4;
      const sat = Math.max(rgba[i], rgba[i + 1], rgba[i + 2]) - Math.min(rgba[i], rgba[i + 1], rgba[i + 2]);
      if (sat < 80) mask[y * w + x] = 1;
    }
  }
  return mask;
}

/** Centres of short bright runs per row (a lane line crosses each row once). */
export function candidatePoints(mask: Uint8Array, w: number, h: number, roiTop: number): { x: number; y: number }[] {
  const pts: { x: number; y: number }[] = [];
  const y0 = Math.floor(h * roiTop);
  const maxRun = Math.max(3, Math.round(w * 0.1));
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
  const mask = paintMask(rgba, w, h, opts.roiTop);
  const pts = candidatePoints(mask, w, h, opts.roiTop);
  const lines = findLines(pts, w, h, opts.roiTop);
  const yb = h - 1, cx = (w - 1) / 2;
  const roiRows = h - Math.floor(h * opts.roiTop);

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
  return { left, right, offset, heading, widthPx, confidence, points: pts.length, width: w, height: h };
}

/**
 * Temporal smoothing across frames: steadier offset/heading, remembered lane
 * width (for one-line frames), and a "lost" state when no lines for a while.
 */
export class LaneTracker {
  offset = 0;
  heading = 0;
  widthPx: number | null = null;
  confidence = 0;
  lastGood = -Infinity;
  private started = false;
  private rejected = 0;

  reset(): void {
    this.started = false;
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
    this.confidence = this.confidence + 0.4 * (m.confidence - this.confidence);
    this.lastGood = t;
    this.started = true;
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
