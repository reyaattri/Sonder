import type { Box, Detection, Zone } from '../core/types';
import { centerX } from './geometry';
import { classInfo } from './classes';

export interface ZoneConfig {
  corridorWidth: number;
  centerWidth: number;
}

export interface FilterConfig extends ZoneConfig {
  minScore: number;
  minHeight: number;
}

/** Zone from the box center: left | center | right. */
export function zoneOf(box: Box, cfg: ZoneConfig): Zone {
  const cx = centerX(box);
  const half = cfg.centerWidth / 2;
  if (cx < 0.5 - half) return 'left';
  if (cx > 0.5 + half) return 'right';
  return 'center';
}

/** Left = -1, center = 0, right = +1 (US-3.1). */
export function zonePan(z: Zone): number {
  return z === 'left' ? -1 : z === 'right' ? 1 : 0;
}

/** True when the box overlaps the walking corridor horizontally. */
export function inCorridor(box: Box, corridorWidth: number): boolean {
  const lo = 0.5 - corridorWidth / 2;
  const hi = 0.5 + corridorWidth / 2;
  return box.x + box.w > lo && box.x < hi;
}

/** Fraction of the center zone's width that the box covers (0..1). */
export function centerOverlap(box: Box, centerWidth: number): number {
  const lo = 0.5 - centerWidth / 2;
  const hi = 0.5 + centerWidth / 2;
  const ov = Math.min(hi, box.x + box.w) - Math.max(lo, box.x);
  return Math.max(0, ov) / centerWidth;
}

/**
 * Keep only detections EchoPath cares about: known classes, confident enough,
 * big enough (not far away) and inside the walking corridor (US-2.2).
 */
export function filterDetections(dets: Detection[], cfg: FilterConfig): Detection[] {
  return dets.filter(
    (d) =>
      classInfo(d.label) !== undefined &&
      d.score >= cfg.minScore &&
      d.box.h >= cfg.minHeight &&
      inCorridor(d.box, cfg.corridorWidth),
  );
}
