import { describe, expect, it } from 'vitest';
import type { Track } from '../perception/tracker';
import { phrase, WarningPolicy } from './warnings';

const t = (id: number, ttc: number, extra: Partial<Track> = {}): Track => ({
  id,
  label: 'person',
  category: 'person',
  score: 0.9,
  box: { x: 0.4, y: 0.2, w: 0.1, h: 0.5 },
  hits: 10,
  firstSeen: 0,
  lastSeen: 0,
  confirmed: true,
  zone: 'left',
  azimuth: -0.3,
  distance: 3,
  band: 'near',
  ttc,
  approaching: Number.isFinite(ttc),
  history: [],
  ...extra,
});

describe('spoken warnings', () => {
  it('phrases like "Person, left, about three seconds"', () => {
    expect(phrase('person', 'left', 3.2)).toBe('Person, left, about three seconds');
    expect(phrase('bicycle', 'center', 0.7)).toBe('Bicycle, center, about one second');
  });

  it('only speaks under 3 s, in your path (or a vehicle), high confidence, respecting verbosity', () => {
    const w = new WarningPolicy();
    const c = { zone: 'center' as const };
    expect(w.update([t(1, 3.5, c)], 0, 'all')).toHaveLength(0);
    expect(w.update([t(1, 2.5, c)], 0, 'all')).toHaveLength(1);
    expect(w.update([t(1, 2.5)], 0, 'all')).toHaveLength(0); // beside your path: heard, not spoken
    expect(w.update([t(1, 2.5, { category: 'vehicle', label: 'car' })], 0, 'all')).toHaveLength(1);
    expect(w.update([t(1, 2.7, c)], 0, 'urgent')).toHaveLength(0);
    expect(w.update([t(1, 2, c)], 0, 'urgent')).toHaveLength(1);
    expect(w.update([t(1, 2, c)], 0, 'off')).toHaveLength(0);
    expect(w.update([t(1, 2, { ...c, score: 0.4 })], 0, 'all')).toHaveLength(0);
    expect(w.update([t(1, 2, { ...c, hits: 2 })], 0, 'all')).toHaveLength(0);
  });

  it('most urgent first, and each object is warned about once', () => {
    const w = new WarningPolicy();
    const c = { zone: 'center' as const };
    const out = w.update([t(1, 2.8, c), t(2, 1.5, c)], 0, 'all');
    expect(out.map((x) => x.trackId)).toEqual([2, 1]);
    w.markSpoken(2, 0);
    expect(w.update([t(2, 1.2, c)], 3000, 'all')).toHaveLength(0);
    expect(w.update([t(2, 1.2, c)], 60000, 'all')).toHaveLength(0);
  });
});
