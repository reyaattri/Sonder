import { describe, expect, it } from 'vitest';
import { groundMap } from './ground';
import { clock, LiveScan } from './liveScan';
import { COLS, ROWS } from './freespace';

const W = 160, H = 120;

/** Smooth grey path; optional busy brown leaf patch and green grass at the sides. */
function scene(opts: { leavesAt?: [number, number]; grass?: boolean } = {}) {
  const px = new Uint8ClampedArray(W * H * 4);
  let seed = 5;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      const u = x / W, v = y / H;
      let rgb = [150, 149, 146], n = (rnd() - 0.5) * 6;
      if (opts.grass && (u < 0.2 || u > 0.8)) {
        rgb = [70, 130, 55];
        n = (rnd() - 0.5) * 60;
      }
      if (opts.leavesAt && Math.abs(u - opts.leavesAt[0]) < 0.12 && Math.abs(v - opts.leavesAt[1]) < 0.12) {
        const k = rnd();
        rgb = k < 0.4 ? [160, 100, 45] : k < 0.7 ? [200, 160, 90] : [110, 70, 35];
        n = (rnd() - 0.5) * 30;
      }
      px[i] = rgb[0] + n;
      px[i + 1] = rgb[1] + n;
      px[i + 2] = rgb[2] + n;
      px[i + 3] = 255;
    }
  return px;
}

describe('leaf litter on the ground', () => {
  it('finds a patch of leaves on the path ahead, and where it is', () => {
    const g = groundMap(scene({ leavesAt: [0.5, 0.8] }), W, H);
    expect(g.corridor).toBeGreaterThan(0.1);
    expect(g.aheadX!).toBeCloseTo(0.5, 1);
  });
  it('a clean path with green grass verges has no leaves', () => {
    const g = groundMap(scene({ grass: true }), W, H);
    expect(g.corridor).toBe(0);
    expect(g.left + g.right).toBe(0);
  });
});

describe('scan around you', () => {
  const pathAhead = () => {
    const freeHeight = new Float32Array(COLS).fill(0.1);
    for (let c = 9; c < 15; c++) freeHeight[c] = 0.9;
    return { path: new Uint8Array(ROWS * COLS), freeHeight, confidence: 0.9 };
  };
  it('clock positions', () => {
    expect(clock(0)).toBe("12 o'clock");
    expect(clock(Math.PI / 2)).toBe("3 o'clock");
    expect(clock(-Math.PI / 2)).toBe("9 o'clock");
    expect(clock(Math.PI / 6)).toBe("1 o'clock");
  });
  it('reports the path, nearby things by clock position, and leaves', () => {
    const s = new LiveScan();
    s.start(0, 0);
    const bench = { confirmed: true, label: 'bench', distance: 3.2, azimuth: 0.5 } as never;
    for (let i = 0; i < 12; i++)
      s.add({
        yaw: 0,
        hfov: 1.0,
        path: pathAhead(),
        tracks: [bench],
        ground: { leaves: new Uint8Array(0), corridor: 0.3, aheadX: 0.5, left: 0, right: 0 },
        depth: null,
      });
    const say = s.summary(0).join(' ');
    expect(say).toContain("Walkable path at 12 o'clock, straight ahead.");
    expect(say).toContain("Bench, 1 o'clock, about 3 metres.");
    expect(say).toContain('Leaves on the path');
  });
  it('turned since the scan: positions are relative to where you face now', () => {
    const s = new LiveScan();
    s.start(0, 0);
    for (let i = 0; i < 12; i++) s.add({ yaw: 0, hfov: 1.0, path: pathAhead(), tracks: [], ground: null, depth: null });
    expect(s.summary(Math.PI / 2)[0]).toContain("9 o'clock");
  });
});
