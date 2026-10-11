import { describe, expect, it } from 'vitest';
import type { Box } from '../core/types';
import { chooseGuide, COLS, pathDebris, PathEstimator, ROWS, sideRoom, type PathModel } from './freespace';

const W = 80, H = 60;

/**
 * A grey paved path between green grass verges. `pathL`/`pathR` are the
 * path's edges (fraction of width) at the bottom; it narrows toward the
 * horizon. Grain everywhere; a dark shadow band crosses the path.
 */
function scene(pathL: number, pathR: number, person?: Box) {
  const px = new Uint8ClampedArray(W * H * 4);
  let seed = 3;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let y = 0; y < H; y++) {
    const t = Math.max(0, (y - H * 0.3) / (H * 0.7)); // 0 at horizon, 1 at bottom
    const l = 0.5 + (pathL - 0.5) * (0.35 + 0.65 * t);
    const r = 0.5 + (pathR - 0.5) * (0.35 + 0.65 * t);
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      const n = (rnd() - 0.5) * 18;
      const u = x / W;
      let rgb: [number, number, number];
      if (y < H * 0.3) rgb = [150, 180, 210]; // sky
      else if (u >= l && u <= r) rgb = [128, 126, 122]; // path
      else rgb = [70, 135, 55]; // grass
      if (y > H * 0.62 && y < H * 0.7 && u >= l && u <= r) rgb = rgb.map((v) => v * 0.55) as typeof rgb; // shadow
      if (person && u >= person.x && u <= person.x + person.w && y / H >= person.y && y / H <= person.y + person.h)
        rgb = [40, 40, 70];
      px[i] = rgb[0] + n;
      px[i + 1] = rgb[1] + n;
      px[i + 2] = rgb[2] + n;
      px[i + 3] = 255;
    }
  }
  return px;
}

function model(pathL: number, pathR: number, person?: Box) {
  const est = new PathEstimator();
  const exclude = person ? [person] : [];
  let m = est.update(scene(pathL, pathR, person), W, H, exclude);
  for (let i = 0; i < 3; i++) m = est.update(scene(pathL, pathR, person), W, H, exclude);
  return m;
}

describe('walkable path estimate', () => {
  it('separates path from grass, and counts the shadow as path', () => {
    const m = model(0.25, 0.75);
    expect(m.confidence).toBeGreaterThan(0.5);
    expect(m.freeHeight[12]).toBeGreaterThan(0.8); // middle column: path all the way up
    expect(m.freeHeight[1]).toBeLessThan(0.2); // far left: grass
  });

  it("YOUR CASE: person ahead on the path's right side -> step LEFT (right of them is grass)", () => {
    // Path spans 15%..70%. Person stands at 48%..64%: little path to their right.
    const person = { x: 0.48, y: 0.35, w: 0.16, h: 0.5 };
    const m = model(0.15, 0.7, person);
    const room = sideRoom(m, person);
    expect(room.left).toBeGreaterThan(room.right);
    expect(chooseGuide(m, person, 0.12, null)).toBe('left');
  });

  it('person on the left of the path -> step right', () => {
    const person = { x: 0.3, y: 0.35, w: 0.16, h: 0.5 };
    expect(chooseGuide(model(0.25, 0.85, person), person, 0.12, null)).toBe('right');
  });

  it('narrow path fully blocked -> no way around (do not send the user onto the grass)', () => {
    const person = { x: 0.36, y: 0.35, w: 0.28, h: 0.55 };
    expect(chooseGuide(model(0.33, 0.67, person), person, 0.12, null)).toBe('none');
  });

  it('no reference yet -> unknown (caller falls back to the old clutter rule)', () => {
    const est = new PathEstimator();
    const blocked = { x: 0.2, y: 0.5, w: 0.6, h: 0.5 }; // covers the whole reference patch
    const m = est.update(scene(0.2, 0.8, blocked), W, H, [blocked]);
    expect(chooseGuide(m, blocked, 0.12, null)).toBe('unknown');
  });
});

describe('flat debris on the path', () => {
  const pathAll = (): PathModel => ({ path: new Uint8Array(ROWS * COLS).fill(1), freeHeight: new Float32Array(COLS).fill(1), confidence: 1 });
  it('a patch of leaves in the middle of the path is found', () => {
    const m = pathAll();
    m.path[(ROWS - 3) * COLS + 11] = 0;
    m.path[(ROWS - 3) * COLS + 12] = 0;
    const d = pathDebris(m)!;
    expect(d).not.toBeNull();
    expect(d.x).toBeCloseTo(0.5, 1);
  });
  it('a clean path, or the path simply ending at a verge, is not debris', () => {
    expect(pathDebris(pathAll())).toBeNull();
    const m = pathAll();
    for (let c = 0; c < 9; c++) m.path[(ROWS - 3) * COLS + c] = 0; // verge to the left
    expect(pathDebris(m)).toBeNull();
  });
});
