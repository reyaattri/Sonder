import type { CameraModel } from '../track/world';

/**
 * Turning a monocular depth AI's RELATIVE output into metres, without LiDAR.
 *
 * Depth Anything outputs relative inverse depth ("disparity"): bigger =
 * closer, up to an unknown scale and shift. Project Guideline solved the same
 * problem by aligning ML depth to ARCore's 3D points with RANSAC. In a
 * browser we have no ARCore, but we DO know the geometry of the ground: from
 * the camera's tilt (accelerometer) and height, every ground pixel's true
 * distance is known. So we fit   1/range = a * disparity + b   on pixels
 * that agree with the ground (RANSAC rejects obstacles), and then every pixel
 * - ground, wall, branch - gets a metric 3D position.
 */

export interface DepthMap {
  data: Float32Array;
  width: number;
  height: number;
}

export interface Alignment {
  a: number;
  b: number;
  /** Fraction of ground samples that agreed. */
  quality: number;
}

interface Ray {
  x: number;
  y: number; // down
  z: number; // forward (horizontal)
}

function ray(u: number, v: number, cam: CameraModel): Ray {
  const f = Math.max(cam.width, cam.height) / 2 / Math.tan((cam.fovDeg * Math.PI) / 360);
  const dx = u - cam.width / 2, dy = v - cam.height / 2;
  const c = Math.cos(cam.pitch), s = Math.sin(cam.pitch);
  return { x: dx, y: dy * c + f * s, z: -dy * s + f * c };
}

const norm = (r: Ray) => Math.hypot(r.x, r.y, r.z);

/** Range (m, along the ray) to the ground for a pixel, or null above the horizon / too far. */
export function groundRange(u: number, v: number, cam: CameraModel): number | null {
  const r = ray(u, v, cam);
  if (r.y <= 1e-6) return null;
  const t = cam.mountHeight / r.y;
  const range = t * norm(r);
  return range < 25 ? range : null;
}

/**
 * RANSAC fit of 1/range = a*d + b over pixels in the lower part of the image
 * whose geometry says "ground". Obstacles standing on the ground disagree
 * and are rejected as outliers.
 */
export function alignToGround(dm: DepthMap, cam: CameraModel, iters = 80): Alignment | null {
  const sx = cam.width / dm.width, sy = cam.height / dm.height;
  const samples: { d: number; q: number }[] = [];
  for (let y = Math.floor(dm.height * 0.55); y < dm.height; y += 2)
    for (let x = 1; x < dm.width; x += 3) {
      const r = groundRange((x + 0.5) * sx, (y + 0.5) * sy, cam);
      if (r === null || r > 12) continue;
      samples.push({ d: dm.data[y * dm.width + x], q: 1 / r });
    }
  if (samples.length < 12) return null;
  let seed = 7;
  const rnd = (n: number) => (seed = (seed * 16807) % 2147483647) % n;
  let best: { a: number; b: number; n: number } | null = null;
  for (let i = 0; i < iters; i++) {
    const p = samples[rnd(samples.length)], q = samples[rnd(samples.length)];
    if (Math.abs(p.d - q.d) < 1e-6) continue;
    const a = (p.q - q.q) / (p.d - q.d);
    if (a <= 0) continue; // closer must mean larger disparity
    const b = p.q - a * p.d;
    let n = 0;
    for (const s of samples) if (Math.abs(a * s.d + b - s.q) < 0.12 * s.q) n++;
    if (!best || n > best.n) best = { a, b, n };
  }
  if (!best) return null;
  // Least-squares refine on inliers.
  const inl = samples.filter((s) => Math.abs(best!.a * s.d + best!.b - s.q) < 0.12 * s.q);
  const n = inl.length;
  const md = inl.reduce((t, s) => t + s.d, 0) / n, mq = inl.reduce((t, s) => t + s.q, 0) / n;
  let num = 0, den = 0;
  for (const s of inl) {
    num += (s.d - md) * (s.q - mq);
    den += (s.d - md) ** 2;
  }
  const a = den > 0 ? num / den : best.a;
  if (!(a > 0)) return null;
  return { a, b: mq - a * md, quality: n / samples.length };
}

export interface Obstacle {
  /** Forward distance, m. */
  z: number;
  /** Lateral, m (+ right). */
  x: number;
  /** Height above ground of the nearest part, m. */
  height: number;
}

export interface Occupancy {
  left: Obstacle | null;
  center: Obstacle | null;
  right: Obstacle | null;
  /** Something at head/chest height in your path (a cane would miss it). */
  head: Obstacle | null;
  /** Something LOW in your path - a rock, kerb or step (4-15 cm high), nearest. */
  low: Obstacle | null;
  /** Echo directions: per azimuth bin, nearest surface range (m) and how much of the bin it fills. */
  echoes: { azimuth: number; range: number; strength: number }[];
}

const BINS = 12;

/**
 * Metric 3D points from aligned depth -> an occupancy picture of the path
 * (after Project Guideline's occupancy map with a clearance zone): the
 * nearest thing standing up out of the ground in the left / centre / right
 * of your path, head-height hazards, and echo directions for echolocation.
 */
export function occupancy(dm: DepthMap, cam: CameraModel, al: Alignment, corridorHalf = 0.45): Occupancy {
  const sx = cam.width / dm.width, sy = cam.height / dm.height;
  const out: Occupancy = { left: null, center: null, right: null, head: null, low: null, echoes: [] };
  // Low-obstacle cells (0.25 m), like Project Guideline's occupancy grid: a
  // cell only counts with several points in it, so depth noise can't trip it.
  const lowCells = new Map<string, { n: number; o: Obstacle }>();
  const half = (cam.fovDeg / 2) * (Math.PI / 180) * (Math.min(cam.width, cam.height) / Math.max(cam.width, cam.height));
  const bins = Array.from({ length: BINS }, () => ({ range: Infinity, hits: 0, total: 0 }));
  const closer = (o: Obstacle | null, z: number) => !o || z < o.z;
  for (let y = 0; y < dm.height; y += 2)
    for (let x = 0; x < dm.width; x += 2) {
      const q = al.a * dm.data[y * dm.width + x] + al.b;
      if (!(q > 1 / 30)) continue; // sky / beyond 30 m
      const range = 1 / q;
      const r = ray((x + 0.5) * sx, (y + 0.5) * sy, cam);
      const t = range / norm(r);
      const px = r.x * t, py = r.y * t, pz = r.z * t;
      const height = cam.mountHeight - py;
      // Echo bins (everything that reflects, ground excluded).
      const az = Math.atan2(px, pz);
      const bi = Math.floor(((az + half) / (2 * half)) * BINS);
      if (bi >= 0 && bi < BINS) {
        bins[bi].total++;
        if (height > 0.2 && range < 8) {
          bins[bi].hits++;
          bins[bi].range = Math.min(bins[bi].range, range);
        }
      }
      if (height >= 0.04 && height < 0.15 && pz > 0.4 && pz < 3 && Math.abs(px) <= corridorHalf) {
        const key = `${Math.floor(px / 0.25)},${Math.floor(pz / 0.25)}`;
        const c = lowCells.get(key);
        if (c) {
          c.n++;
          if (pz < c.o.z) c.o = { z: pz, x: px, height };
        } else lowCells.set(key, { n: 1, o: { z: pz, x: px, height } });
      }
      if (height < 0.15 || height > 2.1 || pz < 0.3 || pz > 6) continue;
      const o = { z: pz, x: px, height };
      if (Math.abs(px) <= corridorHalf) {
        if (closer(out.center, pz)) out.center = o;
        if (height > 1.1 && closer(out.head, pz)) out.head = o;
      } else if (px < -corridorHalf && px > -1.6) {
        if (closer(out.left, pz)) out.left = o;
      } else if (px > corridorHalf && px < 1.6) {
        if (closer(out.right, pz)) out.right = o;
      }
    }
  for (const c of lowCells.values()) if (c.n >= 6 && (!out.low || c.o.z < out.low.z)) out.low = c.o;
  out.echoes = bins
    .map((b, i) => ({ azimuth: -half + ((i + 0.5) / BINS) * 2 * half, range: b.range, strength: b.total ? b.hits / b.total : 0 }))
    .filter((e) => Number.isFinite(e.range) && e.strength > 0.08);
  return out;
}
