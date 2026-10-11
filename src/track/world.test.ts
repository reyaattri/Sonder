import { describe, expect, it } from 'vitest';
import { controlFrom, evalCurve, groundPoint, GuidelineMap, imagePoint, Kalman1D, ransacCurve, type CameraModel } from './world';

const cam: CameraModel = { width: 160, height: 120, fovDeg: 65, pitch: (25 * Math.PI) / 180, mountHeight: 1.3 };

describe('ground projection', () => {
  it('the image centre lands where the tilted optical axis meets the ground', () => {
    const p = groundPoint(80, 60, cam)!;
    expect(p.x).toBeCloseTo(0, 6);
    expect(p.z).toBeCloseTo(1.3 / Math.tan(cam.pitch), 4);
  });

  it('round-trips ground -> image -> ground', () => {
    for (const g of [
      { x: 0.6, z: 3 },
      { x: -1.1, z: 6 },
      { x: 0, z: 12 },
    ]) {
      const ip = imagePoint(g, cam)!;
      const back = groundPoint(ip.u, ip.v, cam)!;
      expect(back.x).toBeCloseTo(g.x, 4);
      expect(back.z).toBeCloseTo(g.z, 4);
    }
  });

  it('above the horizon is not ground', () => {
    expect(groundPoint(80, 0, { ...cam, pitch: 0.05 })).toBeNull();
  });
});

describe('RANSAC curve fit', () => {
  const line = (z: number) => 0.4 - 0.05 * z + 0.004 * z * z;
  it('recovers a gently curving line despite outliers and noise', () => {
    let seed = 3;
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const pts = [];
    for (let i = 0; i < 80; i++) {
      const z = 1 + rnd() * 10;
      pts.push({ x: line(z) + (rnd() - 0.5) * 0.06, z });
    }
    for (let i = 0; i < 25; i++) pts.push({ x: (rnd() - 0.5) * 6, z: 1 + rnd() * 10 }); // junk
    const k = ransacCurve(pts)!;
    expect(k.c0).toBeCloseTo(0.4, 1);
    expect(evalCurve(k, 8)).toBeCloseTo(line(8), 1);
    expect(k.inliers).toBeGreaterThan(70);
  });
});

describe('multi-frame map', () => {
  it('points move back as you run, so old and new keypoints agree', () => {
    const m = new GuidelineMap();
    m.update([{ x: 0.3, z: 5 }], 0, 0, 0);
    m.update([], 1.5, 0, 100);
    expect(m.points()[0].z).toBeCloseTo(3.5, 6);
  });

  it('turning right swings remembered points to your left', () => {
    const m = new GuidelineMap();
    m.update([{ x: 0, z: 5 }], 0, 0, 0);
    m.update([], 0, 0.2, 50);
    expect(m.points()[0].x).toBeLessThan(-0.5);
  });

  it('forgets old points', () => {
    const m = new GuidelineMap();
    m.update([{ x: 0, z: 5 }], 0, 0, 0);
    m.update([], 0, 0, 2000);
    expect(m.size).toBe(0);
  });
});

describe('control (look-ahead steering)', () => {
  it('line 0.3 m to your left: you are right of it, steer left', () => {
    const c = controlFrom({ c0: -0.3, c1: 0, c2: 0, inliers: 50, reach: 10 }, 4);
    expect(c.lateral).toBeCloseTo(0.3, 6);
    expect(c.steer).toBeLessThan(0);
  });

  it('a bend to the right ahead shows up as a positive turn', () => {
    const c = controlFrom({ c0: 0, c1: 0, c2: 0.02, inliers: 50, reach: 12 }, 4);
    expect(c.turnAhead).toBeGreaterThan(0.3);
  });
});

describe('Kalman smoothing', () => {
  it('smooths noise and follows a steady drift', () => {
    const k = new Kalman1D(0.5, 0.02);
    let seed = 9;
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    let out = 0;
    for (let i = 0; i < 120; i++) {
      k.predict(1 / 30);
      out = k.update(0.01 * i + (rnd() - 0.5) * 0.2);
    }
    expect(out).toBeCloseTo(1.19, 0);
    expect(Math.abs(k.v - 0.3)).toBeLessThan(0.25);
  });
});
