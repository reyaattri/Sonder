import type { Box, Category, Detection, DistanceBand, FrameSize, Zone } from '../core/types';
import { classInfo } from './classes';
import { azimuthRad, bandOf, centerX, centerY, distanceM, iou } from './geometry';
import { zoneOf, type ZoneConfig } from './zones';

export interface Track {
  id: number;
  label: string;
  category: Category;
  score: number;
  /** Smoothed box. */
  box: Box;
  hits: number;
  firstSeen: number;
  lastSeen: number;
  /** True once seen on enough frames to trust (suppresses one-frame flickers). */
  confirmed: boolean;
  zone: Zone;
  azimuth: number;
  /** Radians above (+) or below (-) the camera axis: head-height things sound higher. */
  elevation?: number;
  distance: number;
  band: DistanceBand;
  /** Seconds until contact, from box growth (tau ~ h / (dh/dt)); Infinity if not approaching. */
  ttc: number;
  approaching: boolean;
  /**
   * Raw apparent-size samples (h = 1 / distance) for time-to-contact. Using
   * 1/d rather than box height keeps working when the box is clipped by the
   * frame edge, since distance then falls back to the width estimate.
   */
  history: { t: number; h: number }[];
}

export interface TrackerConfig extends ZoneConfig {
  frame: FrameSize;
  focal: number;
}

/** Seen on 3 frames before it can cue: fewer one-frame false alarms. */
const CONFIRM_HITS = 3;
const MAX_AGE_MS = 600;
const HISTORY_MS = 1500;
const TTC_MIN_SAMPLES = 5;
const SMOOTH = 0.45;

/**
 * Least-squares slope of h over t (per second) on the recent history.
 * Smoothing over >= 5 frames keeps detector jitter from faking an approach.
 */
export function growthRate(history: { t: number; h: number }[]): number | null {
  if (history.length < TTC_MIN_SAMPLES) return null;
  const n = history.length;
  let st = 0, sh = 0;
  for (const p of history) {
    st += p.t;
    sh += p.h;
  }
  const mt = st / n, mh = sh / n;
  let num = 0, den = 0;
  for (const p of history) {
    num += (p.t - mt) * (p.h - mh);
    den += (p.t - mt) ** 2;
  }
  if (den === 0) return null;
  return (num / den) * 1000;
}

export function timeToContact(history: { t: number; h: number }[]): number {
  const rate = growthRate(history);
  if (rate === null || rate <= 0) return Infinity;
  const h = history[history.length - 1].h;
  // Ignore growth too slow to matter (< 3 % of size per second): it is jitter.
  if (rate / h < 0.03) return Infinity;
  return h / rate;
}

/** Apparent size, proportional to 1 / estimated distance. */
function apparentSize(d: Detection, cfg: TrackerConfig): number {
  const info = classInfo(d.label)!;
  return 1 / distanceM(d.box, cfg.frame, cfg.focal, info.height, info.width);
}

/**
 * Lightweight IoU tracker: assigns stable IDs across frames so cues can be
 * rate-limited per object (US-2.3) and growth measured for time-to-contact.
 */
export class Tracker {
  private tracks: Track[] = [];
  private nextId = 1;
  /** Per-track label votes (score-weighted): a detector flickering between
   *  "chair" and "bench" settles on the majority instead of the latest. */
  private votes = new Map<number, Map<string, number>>();

  get all(): readonly Track[] {
    return this.tracks;
  }

  reset(): void {
    this.tracks = [];
    this.votes.clear();
  }

  private vote(id: number, label: string, score: number): string {
    let v = this.votes.get(id);
    if (!v) this.votes.set(id, (v = new Map()));
    for (const [k, n] of v) v.set(k, n * 0.9); // older votes fade
    v.set(label, (v.get(label) ?? 0) + score);
    let best = label, bestN = -1;
    for (const [k, n] of v) if (n > bestN) [best, bestN] = [k, n];
    return best;
  }

  update(dets: Detection[], t: number, cfg: TrackerConfig): Track[] {
    const pairs: { ti: number; di: number; s: number }[] = [];
    dets.forEach((d, di) => {
      const cat = classInfo(d.label)?.category;
      this.tracks.forEach((tr, ti) => {
        if (tr.category !== cat) return;
        const ov = iou(tr.box, d.box);
        const dist = Math.hypot(centerX(tr.box) - centerX(d.box), centerY(tr.box) - centerY(d.box));
        const near = dist < 0.6 * Math.max(tr.box.w, tr.box.h);
        if (ov >= 0.15 || near) pairs.push({ ti, di, s: ov + (near ? 0.1 : 0) + (tr.label === d.label ? 0.05 : 0) });
      });
    });
    pairs.sort((a, b) => b.s - a.s);

    const usedT = new Set<number>();
    const usedD = new Set<number>();
    for (const p of pairs) {
      if (usedT.has(p.ti) || usedD.has(p.di)) continue;
      usedT.add(p.ti);
      usedD.add(p.di);
      const tr = this.tracks[p.ti];
      const d = dets[p.di];
      tr.box = {
        x: tr.box.x + SMOOTH * (d.box.x - tr.box.x),
        y: tr.box.y + SMOOTH * (d.box.y - tr.box.y),
        w: tr.box.w + SMOOTH * (d.box.w - tr.box.w),
        h: tr.box.h + SMOOTH * (d.box.h - tr.box.h),
      };
      tr.label = this.vote(tr.id, d.label, d.score);
      tr.score = Math.max(d.score, tr.score * 0.9);
      tr.hits++;
      tr.lastSeen = t;
      tr.history.push({ t, h: apparentSize(d, cfg) });
    }

    dets.forEach((d, di) => {
      if (usedD.has(di)) return;
      const info = classInfo(d.label);
      if (!info) return;
      this.tracks.push({
        id: this.nextId++,
        label: d.label,
        category: info.category,
        score: d.score,
        box: { ...d.box },
        hits: 1,
        firstSeen: t,
        lastSeen: t,
        confirmed: false,
        zone: 'center',
        azimuth: 0,
        distance: Infinity,
        band: 'far',
        ttc: Infinity,
        approaching: false,
        history: [{ t, h: apparentSize(d, cfg) }],
      });
    });

    this.tracks = this.tracks.filter((tr) => {
      const keep = t - tr.lastSeen <= MAX_AGE_MS;
      if (!keep) this.votes.delete(tr.id);
      return keep;
    });

    for (const tr of this.tracks) {
      tr.history = tr.history.filter((p) => t - p.t <= HISTORY_MS);
      const info = classInfo(tr.label)!;
      tr.confirmed = tr.hits >= CONFIRM_HITS;
      tr.zone = zoneOf(tr.box, cfg);
      tr.azimuth = azimuthRad(tr.box, cfg.frame, cfg.focal);
      tr.elevation = Math.atan(((0.5 - centerY(tr.box)) * cfg.frame.height) / cfg.focal);
      tr.distance = distanceM(tr.box, cfg.frame, cfg.focal, info.height, info.width);
      tr.band = bandOf(tr.distance);
      tr.ttc = timeToContact(tr.history);
      tr.approaching = tr.ttc < 10;
    }
    return this.tracks;
  }
}
