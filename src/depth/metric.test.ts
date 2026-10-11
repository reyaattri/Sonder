import { describe, expect, it } from 'vitest';
import type { CameraModel } from '../track/world';
import { alignToGround, boxDistance, groundRange, occupancy, type DepthMap } from './metric';

const cam: CameraModel = { width: 196, height: 252, fovDeg: 65, pitch: 0.35, mountHeight: 1.3 };

/** A box standing on the ground: x in [x0,x1] m, at distance z0 (front face), heights [h0,h1]. */
interface Box {
  x0: number;
  x1: number;
  z0: number;
  h0: number;
  h1: number;
}

/**
 * Ray-cast a synthetic scene and produce what a relative depth AI would:
 * disparity = S/range + T (unknown scale/shift) plus noise.
 */
function scene(boxes: Box[], S = 4.2, T = 0.35): DepthMap {
  const W = cam.width, H = cam.height;
  const f = Math.max(W, H) / 2 / Math.tan((cam.fovDeg * Math.PI) / 360);
  const c = Math.cos(cam.pitch), s = Math.sin(cam.pitch);
  const data = new Float32Array(W * H);
  let seed = 5;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let v = 0; v < H; v++)
    for (let u = 0; u < W; u++) {
      const dx = u + 0.5 - W / 2, dy = v + 0.5 - H / 2;
      const r = { x: dx, y: dy * c + f * s, z: -dy * s + f * c };
      const n = Math.hypot(r.x, r.y, r.z);
      let tBest = r.y > 0 ? cam.mountHeight / r.y : Infinity;
      for (const b of boxes) {
        if (r.z <= 0) continue;
        const t = b.z0 / r.z;
        const x = r.x * t, height = cam.mountHeight - r.y * t;
        if (x >= b.x0 && x <= b.x1 && height >= b.h0 && height <= b.h1 && t < tBest) tBest = t;
      }
      const range = Number.isFinite(tBest) ? tBest * n : 1e6;
      data[v * W + u] = S / Math.max(range, 0.1) + T + (rnd() - 0.5) * 0.02;
    }
  return { data, width: W, height: H };
}

describe('ground geometry', () => {
  it('the bottom-centre pixel is the nearest ground', () => {
    const near = groundRange(98, 251, cam)!;
    const far = groundRange(98, 160, cam)!;
    expect(near).toBeLessThan(far);
    expect(near).toBeGreaterThan(1.3);
  });
});

describe('metric alignment (no LiDAR)', () => {
  it('recovers the unknown scale and shift from the ground alone, despite an obstacle', () => {
    const dm = scene([{ x0: -0.5, x1: 0.5, z0: 3, h0: 0, h1: 1.6 }]);
    const al = alignToGround(dm, cam)!;
    // true: 1/range = (d - 0.35)/4.2  ->  a = 1/4.2, b = -0.35/4.2
    expect(al.a).toBeCloseTo(1 / 4.2, 2);
    expect(al.b).toBeCloseTo(-0.35 / 4.2, 2);
    expect(al.quality).toBeGreaterThan(0.5);
  });
});

describe('occupancy (virtual cane)', () => {
  it('finds a wall straight ahead at 3 m', () => {
    const dm = scene([{ x0: -0.4, x1: 0.4, z0: 3, h0: 0, h1: 1.6 }]);
    const o = occupancy(dm, cam, alignToGround(dm, cam)!);
    expect(o.center!.z).toBeCloseTo(3, 0);
    expect(o.left).toBeNull();
  });

  it('a branch at head height (nothing at cane height) is flagged as a head hazard', () => {
    const dm = scene([{ x0: -0.4, x1: 0.4, z0: 2.2, h0: 1.45, h1: 1.9 }]);
    const o = occupancy(dm, cam, alignToGround(dm, cam)!);
    expect(o.head).not.toBeNull();
    expect(o.head!.z).toBeCloseTo(2.2, 0);
  });

  it('a rock on the path (10 cm high) is a LOW obstacle, not a wall', () => {
    const dm = scene([{ x0: -0.2, x1: 0.15, z0: 1.8, h0: 0, h1: 0.1 }]);
    const o = occupancy(dm, cam, alignToGround(dm, cam)!);
    expect(o.low).not.toBeNull();
    expect(o.low!.z).toBeCloseTo(1.8, 0);
    expect(o.center).toBeNull();
  });

  it('an open path has nothing in the corridor', () => {
    const dm = scene([{ x0: 1.0, x1: 1.5, z0: 2.5, h0: 0, h1: 1.0 }]); // something off to the right
    const o = occupancy(dm, cam, alignToGround(dm, cam)!);
    expect(o.center).toBeNull();
    expect(o.low).toBeNull();
    expect(o.right!.z).toBeCloseTo(2.5, 0);
  });

  it('echo bins point toward the surfaces', () => {
    const dm = scene([{ x0: 0.6, x1: 1.6, z0: 2, h0: 0, h1: 2 }]);
    const o = occupancy(dm, cam, alignToGround(dm, cam)!);
    const strongest = o.echoes.reduce((a, b) => (b.strength > a.strength ? b : a));
    expect(strongest.azimuth).toBeGreaterThan(0.1); // to the right
    expect(strongest.range).toBeLessThan(3);
  });
});

describe('measured distance to a detected object', () => {
  it('a short object (a child, 1.1 m tall) 3 m away measures about 3 m, where box size would say much further', () => {
    const dm = scene([{ x0: -0.25, x1: 0.25, z0: 3, h0: 0, h1: 1.1 }]);
    const al = alignToGround(dm, cam)!;
    const f = Math.max(cam.width, cam.height) / 2 / Math.tan((cam.fovDeg * Math.PI) / 360);
    // Project the object's corners to get its image box.
    const px = (x: number, up: number, z: number) => {
      const c = Math.cos(cam.pitch), s = Math.sin(cam.pitch), yd = cam.mountHeight - up;
      const yc = c * yd - s * z, zc = s * yd + c * z;
      return { u: cam.width / 2 + (f * x) / zc, v: cam.height / 2 + (f * yc) / zc };
    };
    const tl = px(-0.25, 1.1, 3), br = px(0.25, 0, 3);
    const box = { x: tl.u / cam.width, y: tl.v / cam.height, w: (br.u - tl.u) / cam.width, h: (br.v - tl.v) / cam.height };
    expect(boxDistance(dm, cam, al, box)!).toBeCloseTo(3, 0);
  });
});
