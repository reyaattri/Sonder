import { describe, expect, it } from 'vitest';
import type { Gray } from './imageStats';
import { LgmdDetector } from './lgmd';

const W = 80, H = 60;

/** Value noise fixed to object coordinates, so texture expands with the object. */
function tex(u: number, v: number): number {
  const s = Math.sin(u * 12.9898 + v * 78.233) * 43758.5453;
  return 40 + 180 * (s - Math.floor(s));
}

/** A textured disk of radius r centred at (cx, cy) on a still, lightly textured background. */
function frame(cx: number, cy: number, r: number, bg = 0): Gray {
  const data = new Float32Array(W * H);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const dx = x - cx, dy = y - cy;
      if (dx * dx + dy * dy < r * r) data[y * W + x] = tex(Math.floor((dx / r) * 6), Math.floor((dy / r) * 6));
      else data[y * W + x] = 110 + 10 * Math.sin(x * 0.7) * Math.cos(y * 0.5) + bg;
    }
  return { data, width: W, height: H };
}

function run(frames: Gray[], sensitivity = 1) {
  const d = new LgmdDetector();
  return frames.map((f) => d.update(f, sensitivity));
}

const still = (n: number) => Array.from({ length: n }, () => frame(40, 30, 6));

describe('LGMD looming detector', () => {
  it('fires for an object approaching head-on, in the center sector', () => {
    // Size grows like 1/distance as it closes in: r = r0 / (1 - t/T)
    const approach = Array.from({ length: 14 }, (_, i) => frame(40, 30, 4 / (1 - i / 16)));
    const out = run([...still(8), ...approach]);
    const hits = out.filter((o) => o.looming !== null);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.at(-1)!.looming).toBe('center');
  });

  it('knows which side: an object looming on the left fires the left sector', () => {
    const approach = Array.from({ length: 14 }, (_, i) => frame(13, 30, 3 / (1 - i / 17)));
    const out = run([...Array.from({ length: 8 }, () => frame(13, 30, 3)), ...approach]);
    const hit = out.find((o) => o.looming !== null);
    expect(hit?.looming).toBe('left');
  });

  it('does not fire for the same object passing sideways', () => {
    const pass = Array.from({ length: 22 }, (_, i) => frame(10 + i * 3, 30, 9));
    expect(run([...still(8), ...pass]).some((o) => o.looming !== null)).toBe(false);
  });

  it('does not fire for an object moving away', () => {
    const recede = Array.from({ length: 14 }, (_, i) => frame(40, 30, 16 * (1 - i / 18)));
    expect(run([...Array.from({ length: 8 }, () => frame(40, 30, 16)), ...recede]).some((o) => o.looming !== null)).toBe(false);
  });

  it('does not fire when nothing moves', () => {
    expect(run(still(30)).some((o) => o.looming !== null)).toBe(false);
  });

  it('feed-forward inhibition ignores whole-field flicker (lights, camera exposure)', () => {
    const flicker = Array.from({ length: 16 }, (_, i) => frame(40, 30, 6, i % 2 ? 60 : 0));
    const out = run([...still(8), ...flicker]);
    expect(out.slice(8).every((o) => o.ffi || o.looming === null)).toBe(true);
    expect(out.some((o) => o.looming !== null)).toBe(false);
  });
});
