import type { Box } from '../core/types';

/**
 * Walkable-path estimate from appearance (after Ulrich & Nourbakhsh's
 * appearance-based obstacle detection): the ground right in front of the
 * user's feet is assumed to be the path they are on. Every cell of the
 * ground region is compared with it in chromaticity and texture, with a wide
 * brightness tolerance so shadows still count as path. The result answers
 * "if I step around this person, is there path on that side?"
 */

export const COLS = 24;
export const ROWS = 14;
/** Ground region starts at this fraction of frame height. */
export const ROI_TOP = 0.4;

export interface PathModel {
  /** ROWS x COLS, 1 = looks like the path under your feet. Row 0 = top of the ground region. */
  path: Uint8Array;
  /** Per column: fraction of the ground region that is continuous path from the bottom up. */
  freeHeight: Float32Array;
  /** 0..1: how much to trust this (is the "path under your feet" reference fresh?). */
  confidence: number;
}

interface Stats {
  r: number;
  g: number;
  l: number;
  t: number;
  sr: number;
  sg: number;
  st: number;
}

function inBoxes(cx: number, cy: number, boxes: Box[]): boolean {
  return boxes.some((b) => cx >= b.x && cx <= b.x + b.w && cy >= b.y && cy <= b.y + b.h);
}

export class PathEstimator {
  private ref: Stats | null = null;
  /** Frames since the reference patch was last visible (feet area not covered). */
  private refAge = Infinity;

  reset(): void {
    this.ref = null;
    this.refAge = Infinity;
  }

  /** `rgba` is a small frame (e.g. 80x60) in the same orientation as detections. `exclude` = detected object boxes. */
  update(rgba: Uint8ClampedArray, w: number, h: number, exclude: Box[]): PathModel {
    const y0 = Math.floor(h * ROI_TOP);
    const ch = (h - y0) / ROWS, cw = w / COLS;
    const n = ROWS * COLS;
    const fr = new Float32Array(n), fg = new Float32Array(n), fl = new Float32Array(n), ft = new Float32Array(n);
    for (let r = 0; r < ROWS; r++)
      for (let c = 0; c < COLS; c++) {
        let sr = 0, sg = 0, sl = 0, st = 0, k = 0;
        const ya = Math.floor(y0 + r * ch), yb = Math.max(ya + 1, Math.floor(y0 + (r + 1) * ch));
        const xa = Math.floor(c * cw), xb = Math.max(xa + 1, Math.floor((c + 1) * cw));
        for (let y = ya; y < yb && y < h; y++)
          for (let x = xa; x < xb && x < w; x++) {
            const i = (y * w + x) * 4;
            const R = rgba[i], G = rgba[i + 1], B = rgba[i + 2];
            const s = R + G + B + 1;
            sr += R / s;
            sg += G / s;
            const l = s / 3;
            sl += l;
            if (x + 1 < w) {
              const j = i + 4;
              st += Math.abs(l - (rgba[j] + rgba[j + 1] + rgba[j + 2]) / 3);
            }
            k++;
          }
        const idx = r * COLS + c;
        fr[idx] = sr / k;
        fg[idx] = sg / k;
        fl[idx] = sl / k;
        ft[idx] = st / k;
      }

    // Reference: bottom two rows, middle columns, minus anything detected there.
    const refIdx: number[] = [];
    for (let r = ROWS - 2; r < ROWS; r++)
      for (let c = Math.floor(COLS * 0.3); c < Math.ceil(COLS * 0.7); c++) {
        const cx = (c + 0.5) / COLS, cy = (y0 + (r + 0.5) * ch) / h;
        if (!inBoxes(cx, cy, exclude)) refIdx.push(r * COLS + c);
      }
    if (refIdx.length >= 4) {
      // Median and MAD, so a strip of verge or a foot in the patch can't skew it.
      const med = (a: Float32Array) => {
        const v = refIdx.map((i) => a[i]).sort((x, y) => x - y);
        return v[Math.floor(v.length / 2)];
      };
      const mad = (a: Float32Array, m: number) => {
        const v = refIdx.map((i) => Math.abs(a[i] - m)).sort((x, y) => x - y);
        return 1.4826 * v[Math.floor(v.length / 2)];
      };
      const m: Stats = { r: med(fr), g: med(fg), l: med(fl), t: med(ft), sr: 0, sg: 0, st: 0 };
      m.sr = mad(fr, m.r);
      m.sg = mad(fg, m.g);
      m.st = mad(ft, m.t);
      if (!this.ref) this.ref = m;
      else for (const k of Object.keys(m) as (keyof Stats)[]) this.ref[k] += 0.15 * (m[k] - this.ref[k]);
      this.refAge = 0;
    } else {
      this.refAge++;
    }

    const path = new Uint8Array(n);
    const freeHeight = new Float32Array(COLS);
    if (!this.ref) return { path, freeHeight, confidence: 0 };
    const R0 = this.ref;
    // Tolerances adapt to the surface's own variation, within hard caps.
    const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
    const tolR = clamp(3 * R0.sr, 0.025, 0.05), tolG = clamp(3 * R0.sg, 0.025, 0.05);
    const tolT = clamp(3 * R0.st, 6, 14);
    for (let i = 0; i < n; i++) {
      const r = Math.floor(i / COLS), c = i % COLS;
      const cx = (c + 0.5) / COLS, cy = (y0 + (r + 0.5) * ch) / h;
      if (inBoxes(cx, cy, exclude)) continue;
      const okChroma = Math.abs(fr[i] - R0.r) < tolR && Math.abs(fg[i] - R0.g) < tolG;
      const okLight = fl[i] > R0.l * 0.4 && fl[i] < R0.l * 1.9; // shadows and sun patches
      const okTexture = Math.abs(ft[i] - R0.t) < tolT;
      if (okChroma && okLight && okTexture) path[i] = 1;
    }
    for (let c = 0; c < COLS; c++) {
      let run = 0, gap = 0;
      for (let r = ROWS - 1; r >= 0; r--) {
        if (path[r * COLS + c]) {
          run++;
          gap = 0;
        } else if (++gap > 1) break;
      }
      freeHeight[c] = run / ROWS;
    }
    // A stale reference (feet area hidden for ~1 s+) fades out of trust.
    return { path, freeHeight, confidence: Math.max(0, 1 - this.refAge / 20) };
  }
}

export interface SideRoom {
  /** Walkable width beside the blocker, as a fraction of frame width. */
  left: number;
  right: number;
  /** Does the path carry on ahead on that side (not just a sliver at foot level)? */
  leftContinues: boolean;
  rightContinues: boolean;
}

/** Path width available on each side of `box`, measured at the box's feet. */
export function sideRoom(m: PathModel, box: Box): SideRoom {
  const footY = Math.min(0.999, box.y + box.h);
  let row = Math.floor(((footY - ROI_TOP) / (1 - ROI_TOP)) * ROWS);
  row = Math.max(1, Math.min(ROWS - 1, row));
  const band = [row - 1, row].filter((r) => r >= 0 && r < ROWS);
  const isPath = (c: number) => band.filter((r) => m.path[r * COLS + c]).length * 2 >= band.length;
  const c0 = Math.floor(box.x * COLS) - 1, c1 = Math.ceil((box.x + box.w) * COLS);
  let left = 0;
  for (let c = c0; c >= 0 && isPath(c); c--) left++;
  let right = 0;
  for (let c = c1; c < COLS && isPath(c); c++) right++;
  const cont = (from: number, to: number) => {
    const cols = [];
    for (let c = Math.max(0, from); c <= Math.min(COLS - 1, to); c++) cols.push(m.freeHeight[c]);
    return cols.length > 0 && Math.max(...cols) >= 0.35;
  };
  return {
    left: left / COLS,
    right: right / COLS,
    leftContinues: left > 0 && cont(c0 - left + 1, c0),
    rightContinues: right > 0 && cont(c1, c1 + right - 1),
  };
}

export type GuideDecision = 'left' | 'right' | 'none' | 'unknown';

/**
 * Which way to step around a blocker so you stay on the path.
 * `needed` = clearance to pass (fraction of frame width at the blocker's depth).
 * 'none' = no walkable way around; 'unknown' = path model not trustworthy.
 */
export function chooseGuide(m: PathModel, box: Box, needed: number, prev: 'left' | 'right' | null): GuideDecision {
  if (m.confidence < 0.3) return 'unknown';
  const room = sideRoom(m, box);
  const leftOk = room.left >= needed && room.leftContinues;
  const rightOk = room.right >= needed && room.rightContinues;
  if (leftOk && rightOk) {
    if (prev && Math.abs(room.left - room.right) < 0.08) return prev; // don't flip-flop
    return room.left > room.right ? 'left' : 'right';
  }
  if (leftOk) return 'left';
  if (rightOk) return 'right';
  return 'none';
}

/**
 * Flat debris on the path (leaves, litter, a puddle): ground cells in your
 * walking corridor that do NOT look like the path, while the path continues
 * on both sides of them in the same row. Depth can't see these (they're
 * flat), but they look different. Returns the nearest such patch, or null.
 */
export function pathDebris(m: PathModel, corridorFrac = 0.4): { x: number; y: number; cells: number } | null {
  if (m.confidence < 0.5) return null;
  const c0 = Math.floor(COLS * (0.5 - corridorFrac / 2)), c1 = Math.ceil(COLS * (0.5 + corridorFrac / 2));
  // Near half of the ground region (closest first).
  for (let r = ROWS - 2; r >= Math.floor(ROWS / 2); r--) {
    let run = 0, best = 0, at = -1;
    for (let c = c0; c < c1; c++) {
      if (m.path[r * COLS + c]) {
        run = 0;
        continue;
      }
      run++;
      if (run > best) [best, at] = [run, c];
    }
    if (best < 1 || best > 4) continue; // nothing, or a whole edge (not debris)
    const left = at - best, right = at + 1;
    const pathLeft = left >= 0 && m.path[r * COLS + left];
    const pathRight = right < COLS && m.path[r * COLS + right];
    const pathBelow = m.path[(r + 1) * COLS + at];
    if (pathLeft && pathRight && pathBelow) {
      return { x: (at - best / 2 + 0.5) / COLS, y: ROI_TOP + ((r + 0.5) / ROWS) * (1 - ROI_TOP), cells: best };
    }
  }
  return null;
}
