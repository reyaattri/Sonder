import { describe, expect, it } from 'vitest';
import type { Detection } from '../core/types';
import { azimuthRad, bandOf, distanceM, focalPx, iou, pulseRateHz } from './geometry';
import { filterDetections, inCorridor, zoneOf, zonePan } from './zones';
import { timeToContact, Tracker } from './tracker';
import { expansion, frameQuality, LoomingDetector, type Gray } from './imageStats';

const frame = { width: 1280, height: 720 };
const f = focalPx(frame, 65);

describe('geometry', () => {
  it('focal length from the long-side field of view', () => {
    expect(f).toBeCloseTo(640 / Math.tan((32.5 * Math.PI) / 180), 6);
    // Same camera held portrait gives the same focal length.
    expect(focalPx({ width: 720, height: 1280 }, 65)).toBeCloseTo(f, 6);
  });

  it('azimuth: centered box is straight ahead, right edge is ~+32.5 deg', () => {
    expect(azimuthRad({ x: 0.45, y: 0.2, w: 0.1, h: 0.5 }, frame, f)).toBeCloseTo(0, 6);
    const edge = azimuthRad({ x: 0.99, y: 0.2, w: 0.02, h: 0.5 }, frame, f);
    expect((edge * 180) / Math.PI).toBeCloseTo(32.5, 0);
    expect(azimuthRad({ x: 0.0, y: 0.2, w: 0.1, h: 0.5 }, frame, f)).toBeLessThan(0);
  });

  it('distance from box height: a 1.7 m person filling half the frame', () => {
    const d = distanceM({ x: 0.4, y: 0.25, w: 0.1, h: 0.5 }, frame, f, 1.7, 0.5);
    expect(d).toBeCloseTo((f * 1.7) / 360, 6);
    expect(d).toBeGreaterThan(3);
    expect(d).toBeLessThan(5);
  });

  it('a box clipped by the frame edge uses the nearer width estimate', () => {
    const clipped = { x: 0.2, y: 0, w: 0.6, h: 1 };
    const byH = (f * 1.7) / 720;
    expect(distanceM(clipped, frame, f, 1.7, 0.5)).toBeLessThan(byH);
  });

  it('bands and pulse rate: 0.8 Hz beyond 5 m to 4 Hz inside 1 m', () => {
    expect(bandOf(8)).toBe('far');
    expect(bandOf(4)).toBe('mid');
    expect(bandOf(2)).toBe('near');
    expect(bandOf(1)).toBe('veryNear');
    expect(pulseRateHz(10)).toBeCloseTo(0.8);
    expect(pulseRateHz(5)).toBeCloseTo(0.8);
    expect(pulseRateHz(3)).toBeCloseTo(2.4);
    expect(pulseRateHz(1)).toBeCloseTo(4);
    expect(pulseRateHz(0.3)).toBeCloseTo(4);
  });

  it('iou', () => {
    expect(iou({ x: 0, y: 0, w: 1, h: 1 }, { x: 0, y: 0, w: 1, h: 1 })).toBe(1);
    expect(iou({ x: 0, y: 0, w: 0.5, h: 1 }, { x: 0.5, y: 0, w: 0.5, h: 1 })).toBe(0);
  });
});

describe('zones', () => {
  const cfg = { corridorWidth: 0.9, centerWidth: 0.34 };
  it('maps box centers to left / center / right with pan -1 / 0 / +1', () => {
    expect(zoneOf({ x: 0.05, y: 0, w: 0.1, h: 0.3 }, cfg)).toBe('left');
    expect(zoneOf({ x: 0.45, y: 0, w: 0.1, h: 0.3 }, cfg)).toBe('center');
    expect(zoneOf({ x: 0.85, y: 0, w: 0.1, h: 0.3 }, cfg)).toBe('right');
    expect([zonePan('left'), zonePan('center'), zonePan('right')]).toEqual([-1, 0, 1]);
  });

  it('corridor excludes boxes entirely at the far edges', () => {
    expect(inCorridor({ x: 0, y: 0, w: 0.04, h: 0.5 }, 0.9)).toBe(false);
    expect(inCorridor({ x: 0, y: 0, w: 0.1, h: 0.5 }, 0.9)).toBe(true);
  });

  it('filters unknown classes, low scores and tiny (far) boxes', () => {
    const dets: Detection[] = [
      { label: 'person', score: 0.9, box: { x: 0.4, y: 0.2, w: 0.1, h: 0.4 } },
      { label: 'person', score: 0.2, box: { x: 0.4, y: 0.2, w: 0.1, h: 0.4 } },
      { label: 'person', score: 0.9, box: { x: 0.4, y: 0.2, w: 0.02, h: 0.05 } },
      { label: 'cup', score: 0.9, box: { x: 0.4, y: 0.2, w: 0.1, h: 0.4 } },
    ];
    const kept = filterDetections(dets, { ...cfg, minScore: 0.45, minHeight: 0.12 });
    expect(kept).toHaveLength(1);
  });
});

describe('tracker', () => {
  const cfg = { frame, focal: f, corridorWidth: 0.9, centerWidth: 0.34 };
  const person = (x: number, h: number, score = 0.9): Detection => ({
    label: 'person',
    score,
    box: { x, y: 0.5 - h / 2, w: h / 3, h },
  });

  it('keeps the same id for a moving object and confirms after 3 hits', () => {
    const tr = new Tracker();
    const a = tr.update([person(0.1, 0.4)], 0, cfg);
    expect(a[0].confirmed).toBe(false);
    const id = a[0].id;
    let tracks = a;
    for (let i = 1; i <= 5; i++) tracks = tr.update([person(0.1 + i * 0.05, 0.4)], i * 66, cfg);
    expect(tracks).toHaveLength(1);
    expect(tracks[0].id).toBe(id);
    expect(tracks[0].confirmed).toBe(true);
  });

  it('label flicker settles on the majority', () => {
    const tr = new Tracker();
    const chair = (label: string): Detection => ({ label, score: 0.8, box: { x: 0.4, y: 0.4, w: 0.2, h: 0.3 } });
    let tracks = tr.update([chair('chair')], 0, cfg);
    for (let i = 1; i < 6; i++) tracks = tr.update([chair('chair')], i * 66, cfg);
    tracks = tr.update([chair('bench')], 6 * 66, cfg); // one stray frame
    expect(tracks[0].label).toBe('chair');
  });

  it('two separate people get two ids; lost tracks expire', () => {
    const tr = new Tracker();
    tr.update([person(0.05, 0.4), person(0.7, 0.4)], 0, cfg);
    const t = tr.update([person(0.05, 0.4), person(0.7, 0.4)], 66, cfg);
    expect(new Set(t.map((x) => x.id)).size).toBe(2);
    expect(tr.update([], 1000, cfg)).toHaveLength(0);
  });

  it('time-to-contact from steady growth: h doubling rate gives tau ~ h / dh/dt', () => {
    // h(t) = 0.2 + 0.1 t  -> at t = 1 s, tau = 0.3 / 0.1 = 3 s
    const hist = Array.from({ length: 10 }, (_, i) => ({ t: 500 + i * 55.6, h: 0.2 + 0.1 * ((500 + i * 55.6) / 1000) }));
    const last = hist[hist.length - 1];
    expect(timeToContact(hist)).toBeCloseTo(last.h / 0.1, 3);
  });

  it('stationary or shrinking objects have infinite time-to-contact', () => {
    const flat = Array.from({ length: 8 }, (_, i) => ({ t: i * 66, h: 0.3 + (i % 2 ? 0.002 : -0.002) }));
    expect(timeToContact(flat)).toBe(Infinity);
    const away = Array.from({ length: 8 }, (_, i) => ({ t: i * 66, h: 0.4 - i * 0.01 }));
    expect(timeToContact(away)).toBe(Infinity);
    expect(timeToContact(away.slice(0, 3))).toBe(Infinity);
  });

  it('ttc still works when a close object is clipped by the frame (height stuck at 1)', () => {
    const tr = new Tracker();
    const clipped = (w: number): Detection => ({ label: 'person', score: 0.9, box: { x: 0.5 - w / 2, y: 0, w, h: 1 } });
    let tracks = tr.update([clipped(0.2)], 0, cfg);
    for (let i = 1; i <= 10; i++) tracks = tr.update([clipped(0.2 + i * 0.02)], i * 66, cfg);
    expect(tracks[0].ttc).toBeLessThan(4);
  });

  it('an approaching person gets a finite ttc and moves to a nearer band', () => {
    const tr = new Tracker();
    let tracks = tr.update([person(0.45, 0.2)], 0, cfg);
    for (let i = 1; i <= 12; i++) tracks = tr.update([person(0.45, 0.2 + i * 0.03)], i * 66, cfg);
    expect(tracks[0].approaching).toBe(true);
    expect(tracks[0].ttc).toBeGreaterThan(0.5);
    expect(tracks[0].ttc).toBeLessThan(4);
  });
});

describe('image stats', () => {
  const W = 64, H = 48;
  const texture = (scale = 1): Gray => {
    const data = new Float32Array(W * H);
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        const u = (x - W / 2) / scale, v = (y - H / 2) / scale;
        data[y * W + x] = 128 + 60 * Math.sin(u * 0.7) * Math.cos(v * 0.9) + 30 * Math.sin((u + v) * 0.31);
      }
    return { data, width: W, height: H };
  };

  it('flags dark and featureless frames', () => {
    const dark = { data: new Float32Array(W * H).fill(10), width: W, height: H };
    const flat = { data: new Float32Array(W * H).fill(120), width: W, height: H };
    expect(frameQuality(dark)).toBe('dark');
    expect(frameQuality(flat)).toBe('blurry');
    expect(frameQuality(texture())).toBe('ok');
  });

  it('measures expansion between a frame and a zoomed-in copy', () => {
    const r = expansion(texture(1), texture(1.07));
    expect(r.scale).toBeCloseTo(1.07, 2);
    expect(expansion(texture(1), texture(1)).scale).toBe(1);
  });

  it('looming fires only on sustained fast expansion', () => {
    const det = new LoomingDetector();
    let s = 1, fired = false;
    for (let i = 0; i < 8; i++) {
      fired = det.update(texture(s), i * 66) || fired;
      s *= 1.07;
    }
    expect(fired).toBe(true);
    const still = new LoomingDetector();
    let any = false;
    for (let i = 0; i < 8; i++) any = still.update(texture(1), i * 66) || any;
    expect(any).toBe(false);
  });
});
