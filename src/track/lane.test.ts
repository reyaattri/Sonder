import { describe, expect, it } from 'vitest';
import { LaneTracker, measureLane } from './lane';

const W = 160, H = 120;

/**
 * Render a synthetic running track: red surface with grain, white lane lines
 * converging to a vanishing point. `shift` = runner's position in the lane
 * (+ = right of centre, in lane widths); `vpShift` moves the vanishing point
 * (simulating heading); `hide` drops lines.
 */
function trackImage(opts: { shift?: number; vpShift?: number; laneW?: number; hide?: ('left' | 'right')[]; neighbours?: boolean } = {}) {
  const { shift = 0, vpShift = 0, laneW = 90, hide = [], neighbours = true } = opts;
  const px = new Uint8ClampedArray(W * H * 4);
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < W * H; i++) {
    const n = (rnd() - 0.5) * 30;
    px[i * 4] = 175 + n;
    px[i * 4 + 1] = 70 + n;
    px[i * 4 + 2] = 55 + n;
    px[i * 4 + 3] = 255;
  }
  const cx = (W - 1) / 2, vy = H * 0.3, vx = cx + vpShift;
  const centreBottom = cx - shift * laneW;
  const lines: [string, number][] = [
    ['left', centreBottom - laneW / 2],
    ['right', centreBottom + laneW / 2],
  ];
  if (neighbours) lines.push(['n1', centreBottom - 1.5 * laneW], ['n2', centreBottom + 1.5 * laneW]);
  for (const [name, xb] of lines) {
    if (hide.includes(name as 'left')) continue;
    for (let y = Math.ceil(vy); y < H; y++) {
      const t = (y - vy) / (H - 1 - vy);
      const x = vx + (xb - vx) * t;
      const half = 0.6 + 1.6 * t;
      for (let xx = Math.floor(x - half); xx <= Math.ceil(x + half); xx++) {
        if (xx < 0 || xx >= W) continue;
        const i = (y * W + xx) * 4;
        px[i] = px[i + 1] = px[i + 2] = 238;
      }
    }
  }
  return px;
}

const opts = { roiTop: 0.45 };

describe('lane detection', () => {
  it('centred runner: offset ~0, both lines found, high confidence', () => {
    const m = measureLane(trackImage(), W, H, opts);
    expect(m.left).not.toBeNull();
    expect(m.right).not.toBeNull();
    expect(m.offset!).toBeCloseTo(0, 1);
    expect(m.widthPx!).toBeGreaterThan(80);
    expect(m.confidence).toBeGreaterThan(0.6);
  });

  it('drifting right of centre gives a positive offset, left negative', () => {
    expect(measureLane(trackImage({ shift: 0.25 }), W, H, opts).offset!).toBeCloseTo(0.25, 1);
    expect(measureLane(trackImage({ shift: -0.3 }), W, H, opts).offset!).toBeCloseTo(-0.3, 1);
  });

  it('picks the runner\'s own lane, not the neighbouring lane lines', () => {
    const m = measureLane(trackImage({ shift: 0.1 }), W, H, opts);
    expect(m.widthPx!).toBeGreaterThan(80);
    expect(m.widthPx!).toBeLessThan(100);
  });

  it('heading toward the right line (vanishing point moves left) is positive', () => {
    expect(measureLane(trackImage({ vpShift: -25 }), W, H, opts).heading!).toBeGreaterThan(0.1);
    expect(measureLane(trackImage({ vpShift: 25 }), W, H, opts).heading!).toBeLessThan(-0.1);
  });

  it('one line visible: uses the remembered lane width', () => {
    const m = measureLane(trackImage({ shift: 0.2, hide: ['right'], neighbours: false }), W, H, { ...opts, expectedWidthPx: 90 });
    expect(m.left).not.toBeNull();
    expect(m.right).toBeNull();
    expect(m.offset!).toBeCloseTo(0.2, 1);
  });

  it('plain track surface with no lines: no measurement', () => {
    const m = measureLane(trackImage({ hide: ['left', 'right'], neighbours: false }), W, H, opts);
    expect(m.offset).toBeNull();
    expect(m.confidence).toBe(0);
  });
});

describe('robustness', () => {
  it('a bright false line inside the lane (another runner) is ignored when the width is known', () => {
    const px = trackImage({ shift: 0.1 });
    // paint a near-vertical bright stripe just right of centre
    for (let y = 60; y < H; y++) for (let x = 95; x < 98; x++) { const i = (y * W + x) * 4; px[i] = px[i + 1] = px[i + 2] = 240; }
    const m = measureLane(px, W, H, { ...opts, expectedWidthPx: 90 });
    expect(m.offset!).toBeCloseTo(0.1, 1);
  });

  it('tracker ignores a single-frame jump but follows one that persists', () => {
    const t = new LaneTracker();
    const ok = measureLane(trackImage({ shift: 0 }), W, H, opts);
    for (let i = 0; i < 5; i++) t.update(ok, i * 33);
    t.update({ ...ok, offset: 0.45 }, 200);
    expect(t.offset).toBeCloseTo(0, 1);
    for (let i = 0; i < 6; i++) t.update({ ...ok, offset: 0.45 }, 233 + i * 33);
    expect(t.offset).toBeGreaterThan(0.3);
  });
});

describe('lane tracker', () => {
  it('smooths, remembers width, and reports lost after 600 ms without lines', () => {
    const t = new LaneTracker();
    for (let i = 0; i < 10; i++) t.update(measureLane(trackImage({ shift: 0.2 }), W, H, opts), i * 33);
    expect(t.offset).toBeCloseTo(0.2, 1);
    expect(t.widthPx!).toBeGreaterThan(80);
    expect(t.lost(400)).toBe(false);
    expect(t.lost(1000)).toBe(true);
  });

  it('predicts drift from heading and speed', () => {
    const t = new LaneTracker();
    t.offset = 0;
    t.heading = 0.2;
    expect(t.predicted(4)).toBeGreaterThan(0.2);
    expect(t.predicted(0)).toBe(0);
  });
});
