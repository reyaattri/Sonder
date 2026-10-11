import type { Box, DistanceBand, FrameSize } from '../core/types';

/**
 * Focal length in pixels. `fovDeg` is the camera's field of view along the
 * frame's LONG side, so the estimate holds whether the phone is portrait
 * (lanyard, chest pocket) or landscape.
 */
export function focalPx(frame: FrameSize, fovDeg: number): number {
  const long = Math.max(frame.width, frame.height);
  return long / 2 / Math.tan((fovDeg * Math.PI) / 360);
}

/** theta = atan((x - w/2) / f). Negative = left of straight ahead. */
export function azimuthRad(box: Box, frame: FrameSize, f: number): number {
  const cxPx = (box.x + box.w / 2) * frame.width;
  return Math.atan((cxPx - frame.width / 2) / f);
}

const EDGE = 0.01;

/**
 * d ~ f*H/h. When the box is cut off by the top or bottom of the frame its
 * height under-reads (making things look farther than they are), so we also
 * estimate from width and keep the nearer of the two.
 */
export function distanceM(box: Box, frame: FrameSize, f: number, realH: number, realW: number): number {
  const hPx = Math.max(1, box.h * frame.height);
  const byHeight = (f * realH) / hPx;
  const clipped = box.y <= EDGE || box.y + box.h >= 1 - EDGE;
  if (!clipped) return byHeight;
  const wPx = Math.max(1, box.w * frame.width);
  return Math.min(byHeight, (f * realW) / wPx);
}

export const BAND_LIMITS = { veryNear: 1.5, near: 3, mid: 5 } as const;

export function bandOf(d: number): DistanceBand {
  if (d < BAND_LIMITS.veryNear) return 'veryNear';
  if (d < BAND_LIMITS.near) return 'near';
  if (d < BAND_LIMITS.mid) return 'mid';
  return 'far';
}

/** 0 = far ... 3 = very near. Higher means closer. */
export function bandRank(b: DistanceBand): number {
  return { far: 0, mid: 1, near: 2, veryNear: 3 }[b];
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * Pulse rate rises as things get closer: 0.8 Hz beyond 5 m to 4 Hz inside 1 m.
 * (The PRD's starting point was 1-6 Hz; in use, beeps that fast felt frantic.)
 */
export function pulseRateHz(d: number): number {
  const t = clamp((5 - d) / 4, 0, 1);
  return 0.8 + 3.2 * t;
}

/** 0 (far, >= 5 m) .. 1 (touching, <= 1 m): drives gain and pitch. */
export function closeness(d: number): number {
  return clamp((5 - d) / 4, 0, 1);
}

export function iou(a: Box, b: Box): number {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w);
  const y2 = Math.min(a.y + a.h, b.y + b.h);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const union = a.w * a.h + b.w * b.h - inter;
  return union > 0 ? inter / union : 0;
}

export const centerX = (b: Box) => b.x + b.w / 2;
export const centerY = (b: Box) => b.y + b.h / 2;
