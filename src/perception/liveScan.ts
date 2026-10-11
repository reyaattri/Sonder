import type { Occupancy } from '../depth/metric';
import { classInfo } from './classes';
import { COLS, type PathModel } from './freespace';
import type { GroundMap } from './ground';
import type { Track } from './tracker';

/**
 * "Scan around you" before walking, like a live-view scan:
 * hold the phone up and turn slowly; EchoPath builds a 360-degree picture
 * (the walkable path's direction, things around you, leaves and steps on the
 * ground) and then says it in a few short sentences using clock positions,
 * the convention orientation-and-mobility instructors teach (12 = ahead).
 */

export interface ScanFrame {
  /** Phone heading, radians clockwise from where the scan started. */
  yaw: number;
  /** Camera horizontal field of view (radians). */
  hfov: number;
  path: PathModel | null;
  tracks: readonly Track[];
  ground: GroundMap | null;
  depth: Occupancy | null;
}

interface Seen {
  what: string;
  worldAz: number;
  distance: number;
}

export const SCAN_MS = 9000;

export class LiveScan {
  private startT = 0;
  private yawMin = 0;
  private yawMax = 0;
  private items: Seen[] = [];
  /** Walkable-path evidence per world bearing bin (10 degrees). */
  private pathBins = new Map<number, number>();
  private leavesAhead: { worldAz: number; n: number } = { worldAz: 0, n: 0 };
  private leavesEdge = 0;
  private lowStep: Seen | null = null;
  private frames = 0;
  active = false;

  start(now: number, yaw: number): void {
    this.startT = now;
    this.yawMin = this.yawMax = yaw;
    this.items = [];
    this.pathBins.clear();
    this.leavesAhead = { worldAz: 0, n: 0 };
    this.leavesEdge = 0;
    this.lowStep = null;
    this.frames = 0;
    this.active = true;
  }

  /** 0..1: time spent, and how much of a left-right sweep you've done. */
  progress(now: number): number {
    const t = (now - this.startT) / SCAN_MS;
    return Math.min(1, t);
  }

  /** Degrees swept so far (0 on a device without a gyroscope). */
  get sweptDeg(): number {
    return ((this.yawMax - this.yawMin) * 180) / Math.PI;
  }

  add(f: ScanFrame): void {
    if (!this.active) return;
    this.frames++;
    this.yawMin = Math.min(this.yawMin, f.yaw);
    this.yawMax = Math.max(this.yawMax, f.yaw);
    // Path: columns where the walkable ground continues far up the image.
    if (f.path && f.path.confidence > 0.4) {
      for (let c = 0; c < COLS; c++) {
        const h = f.path.freeHeight[c];
        if (h < 0.35) continue;
        const az = f.yaw + ((c + 0.5) / COLS - 0.5) * f.hfov;
        const bin = Math.round((az * 180) / Math.PI / 10);
        this.pathBins.set(bin, (this.pathBins.get(bin) ?? 0) + h);
      }
    }
    for (const t of f.tracks) {
      if (!t.confirmed || t.distance > 12) continue;
      this.remember({ what: classInfo(t.label)?.spoken ?? t.label, worldAz: f.yaw + t.azimuth, distance: t.distance });
    }
    if (f.depth) {
      for (const o of [f.depth.center, f.depth.left, f.depth.right])
        if (o && o.z < 4) this.remember({ what: o.height > 1.1 ? 'Something at head height' : 'An obstacle', worldAz: f.yaw + Math.atan2(o.x, o.z), distance: Math.hypot(o.x, o.z) });
      if (f.depth.low && (!this.lowStep || f.depth.low.z < this.lowStep.distance))
        this.lowStep = { what: 'A step or rock', worldAz: f.yaw + Math.atan2(f.depth.low.x, f.depth.low.z), distance: f.depth.low.z };
    }
    if (f.ground) {
      if (f.ground.corridor > 0.15 && f.ground.aheadX !== null) {
        const az = f.yaw + (f.ground.aheadX - 0.5) * f.hfov;
        const n = this.leavesAhead.n;
        this.leavesAhead = { worldAz: (this.leavesAhead.worldAz * n + az) / (n + 1), n: n + 1 };
      }
      if (f.ground.left > 0.2 || f.ground.right > 0.2) this.leavesEdge++;
    }
  }

  /** Merge repeated sightings of the same thing (same name, similar bearing and distance). */
  private remember(s: Seen): void {
    const m = this.items.find(
      (o) => o.what === s.what && Math.abs(wrap(o.worldAz - s.worldAz)) < 0.35 && Math.abs(o.distance - s.distance) < 1.5,
    );
    if (m) {
      m.worldAz = m.worldAz * 0.7 + s.worldAz * 0.3;
      m.distance = Math.min(m.distance, s.distance);
    } else this.items.push(s);
  }

  /**
   * What to say, relative to where you face NOW (`yaw`). Short sentences,
   * most important first: the path, then the nearest things, then the ground.
   */
  summary(yaw: number): string[] {
    this.active = false;
    const out: string[] = [];
    let best: { bin: number; v: number } | null = null;
    for (const [bin, v] of this.pathBins) if (!best || v > best.v) best = { bin, v };
    if (best && best.v > Math.max(2, this.frames * 0.3)) {
      const az = (best.bin * 10 * Math.PI) / 180 - yaw;
      out.push(`Walkable path at ${clock(az)}${Math.abs(az) < 0.26 ? ', straight ahead' : ''}.`);
    } else out.push('I could not find a clear walkable path. Scan again, or walk with care.');
    const things = this.items.sort((a, b) => a.distance - b.distance).slice(0, 4);
    for (const t of things) out.push(`${t.what}, ${clock(t.worldAz - yaw)}, ${metres(t.distance)}.`);
    if (!things.length) out.push('Nothing in the way within a few metres.');
    if (this.lowStep) out.push(`${this.lowStep.what} on the ground, ${clock(this.lowStep.worldAz - yaw)}, ${metres(this.lowStep.distance)}.`);
    if (this.leavesAhead.n >= 3) out.push(`Leaves on the path at ${clock(this.leavesAhead.worldAz - yaw)}. It may be slippery.`);
    else if (this.leavesEdge >= 3) out.push('Leaves along the edge of the path.');
    return out;
  }
}

const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

/** Bearing (radians, + right) -> "2 o'clock". */
export function clock(az: number): string {
  let h = Math.round((wrap(az) / (2 * Math.PI)) * 12);
  if (h <= 0) h += 12;
  return `${h} o'clock`;
}

const metres = (d: number) => (d < 1.5 ? 'about 1 metre' : `about ${Math.round(d)} metres`);
