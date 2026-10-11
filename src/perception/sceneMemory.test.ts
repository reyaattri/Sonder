import { describe, expect, it } from 'vitest';
import type { Track } from './tracker';
import { makeImpulse, SceneMemory } from './sceneMemory';

const deg = (d: number) => (d * Math.PI) / 180;
const tr = (id: number, az: number, t: number, extra: Partial<Track> = {}): Track => ({
  id,
  label: 'person',
  category: 'person',
  score: 0.9,
  box: { x: 0.4, y: 0.3, w: 0.2, h: 0.5 },
  hits: 10,
  firstSeen: 0,
  lastSeen: t,
  confirmed: true,
  zone: 'center',
  azimuth: az,
  distance: 3,
  band: 'near',
  ttc: Infinity,
  approaching: false,
  history: [],
  ...extra,
});

describe('360 scene memory', () => {
  it('in view: widened bearing, not remembered', () => {
    const m = new SceneMemory();
    const [o] = m.update([tr(1, deg(20), 0)], 0, 0, 2);
    expect(o.azimuth).toBeCloseTo(deg(40), 5);
    expect(o.remembered).toBe(false);
  });

  it('someone passing you on the right keeps moving round behind you after leaving view, then fades', () => {
    const m = new SceneMemory();
    for (let i = 0; i <= 10; i++) m.update([tr(1, deg(3 * i), i * 100)], i * 100, 0, 2); // moving right
    const after1s = m.update([], 2000, 0, 2)[0];
    expect(after1s.remembered).toBe(true);
    expect(after1s.azimuth).toBeGreaterThan(deg(80)); // round to your side / behind
    expect(after1s.presence).toBeLessThan(0.9);
    expect(m.update([], 5000, 0, 2)).toHaveLength(0); // forgotten after 3 s
  });

  it('when you turn left, a remembered object stays put in the world (moves to your right)', () => {
    const m = new SceneMemory();
    m.update([tr(1, 0, 0)], 0, 0, 2); // straight ahead, standing still
    m.update([tr(1, 0, 100)], 100, 0, 2);
    const turned = m.update([], 300, deg(-60), 2)[0]; // you turned 60 deg to the left
    expect(turned.azimuth).toBeCloseTo(deg(60), 3);
  });

  it('keeps at most six of the most present things', () => {
    const m = new SceneMemory();
    const many = Array.from({ length: 9 }, (_, i) => tr(i + 1, deg(i * 3 - 12), 0, { distance: 1 + i }));
    expect(m.update(many, 0, 0, 2).length).toBeLessThanOrEqual(6);
  });
});

describe('room impulse (externalisation)', () => {
  it('decays and differs between ears (wide, not mono)', () => {
    const [L, R] = makeImpulse(8000, 1);
    const energy = (a: Float32Array, i0: number, i1: number) => a.slice(i0, i1).reduce((s, v) => s + v * v, 0);
    expect(energy(L, 0, 800)).toBeGreaterThan(energy(L, 6000, 6800) * 20);
    let same = 0;
    for (let i = 0; i < L.length; i++) if (Math.abs(L[i] - R[i]) < 1e-6) same++;
    expect(same / L.length).toBeLessThan(0.05);
  });
});
