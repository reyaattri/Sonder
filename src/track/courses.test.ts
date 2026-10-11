import { describe, expect, it } from 'vitest';
import { LaneTracker, measureLane } from './lane';

const W = 160, H = 120;

/** Asphalt with grain; draws polylines given as x(t) where t: 0 (horizon) .. 1 (bottom). */
function road(lines: { x: (t: number) => number; rgb: [number, number, number]; width?: number }[], surface: [number, number, number] = [70, 70, 72]) {
  const px = new Uint8ClampedArray(W * H * 4);
  let seed = 11;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let i = 0; i < W * H; i++) {
    const n = (rnd() - 0.5) * 24;
    px[i * 4] = surface[0] + n;
    px[i * 4 + 1] = surface[1] + n;
    px[i * 4 + 2] = surface[2] + n;
    px[i * 4 + 3] = 255;
  }
  const vy = H * 0.3;
  for (const l of lines) {
    for (let y = Math.ceil(vy); y < H; y++) {
      const t = (y - vy) / (H - 1 - vy);
      const x = l.x(t);
      const half = (l.width ?? 1) * (0.6 + 1.6 * t);
      for (let xx = Math.floor(x - half); xx <= Math.ceil(x + half); xx++) {
        if (xx < 0 || xx >= W) continue;
        const i = (y * W + xx) * 4;
        [px[i], px[i + 1], px[i + 2]] = l.rgb;
      }
    }
  }
  return px;
}

const cx = (W - 1) / 2;
const straight = (xb: number) => (t: number) => cx + (xb - cx) * t;
const YELLOW: [number, number, number] = [235, 200, 40];
const WHITE: [number, number, number] = [240, 240, 240];
const opts = { roiTop: 0.45 };

describe('course types', () => {
  it("'line' course (Project Guideline / road racing line): yellow line under you = centred", () => {
    const m = measureLane(road([{ x: straight(cx), rgb: YELLOW, width: 2 }]), W, H, { ...opts, mode: 'line', color: 'yellow' });
    expect(m.offset!).toBeCloseTo(0, 1);
    expect(m.confidence).toBeGreaterThan(0.5);
  });

  it("'line' course: runner drifted right of the line = positive offset", () => {
    const m = measureLane(road([{ x: straight(cx - 24), rgb: YELLOW, width: 2 }]), W, H, { ...opts, mode: 'line', color: 'yellow' });
    expect(m.offset!).toBeGreaterThan(0.2);
  });

  it('a yellow-line course ignores white markings', () => {
    const m = measureLane(
      road([
        { x: straight(cx), rgb: YELLOW, width: 2 },
        { x: straight(cx + 30), rgb: WHITE, width: 2 },
      ]),
      W,
      H,
      { ...opts, mode: 'line', color: 'yellow' },
    );
    expect(m.offset!).toBeCloseTo(0, 1);
  });

  it("'edge' course: kerb line kept 30% to your left = on target; closer = drifting toward it", () => {
    const at = measureLane(road([{ x: straight(cx - 0.3 * W), rgb: WHITE, width: 2 }]), W, H, { ...opts, mode: 'edge', edgeSide: 'left' });
    expect(at.offset!).toBeCloseTo(0, 1);
    const close = measureLane(road([{ x: straight(cx - 0.12 * W), rgb: WHITE, width: 2 }]), W, H, { ...opts, mode: 'edge', edgeSide: 'left' });
    expect(close.offset!).toBeLessThan(-0.2); // drifted left, toward the kerb
  });

  it('bend detection: lines curving right ahead give positive curvature', () => {
    const bend = (xb: number) => (t: number) => cx + (xb - cx) * t + 34 * (1 - t) ** 2;
    const lanes = road([{ x: bend(cx - 45), rgb: WHITE, width: 1.5 }, { x: bend(cx + 45), rgb: WHITE, width: 1.5 }], [175, 70, 55]);
    const m = measureLane(lanes, W, H, opts);
    expect(m.curvature!).toBeGreaterThan(0.3);
    const tr = new LaneTracker();
    for (let i = 0; i < 15; i++) tr.update(m, i * 33);
    expect(tr.bend()).toBe('right');
  });

  it('straight lanes: no bend', () => {
    const lanes = road([{ x: straight(cx - 45), rgb: WHITE, width: 1.5 }, { x: straight(cx + 45), rgb: WHITE, width: 1.5 }], [175, 70, 55]);
    const m = measureLane(lanes, W, H, opts);
    expect(Math.abs(m.curvature ?? 0)).toBeLessThan(0.15);
  });
});
