import { describe, expect, it } from 'vitest';
import type { Track } from './tracker';
import { applyEgoMotion, describeScene } from './egomotion';

const t = (over: Partial<Track>): Track => ({
  id: 1,
  label: 'bench',
  category: 'static',
  score: 0.9,
  box: { x: 0.4, y: 0.5, w: 0.2, h: 0.2 },
  hits: 10,
  firstSeen: 0,
  lastSeen: 0,
  confirmed: true,
  zone: 'center',
  azimuth: 0,
  distance: 3,
  band: 'near',
  ttc: Infinity,
  approaching: false,
  history: [],
  ...over,
});

describe('ego-motion', () => {
  it('a static obstacle ahead gets ttc = distance / walking speed', () => {
    const tracks = [t({})];
    applyEgoMotion(tracks, true, 1.2);
    expect(tracks[0].ttc).toBeCloseTo(2.5, 5);
    expect(tracks[0].approaching).toBe(true);
  });

  it('ignores side obstacles, moving objects, and standing still', () => {
    const side = t({ zone: 'left' });
    const person = t({ category: 'person', label: 'person' });
    applyEgoMotion([side, person], true, 1.2);
    expect(side.ttc).toBe(Infinity);
    expect(person.ttc).toBe(Infinity);
    const still = t({});
    applyEgoMotion([still], false, 0);
    expect(still.ttc).toBe(Infinity);
  });
});

describe('describe scene', () => {
  it('nearest first, with side and rough distance', () => {
    const text = describeScene([
      t({ id: 1, label: 'person', category: 'person', zone: 'left', distance: 4.2 }),
      t({ id: 2, label: 'chair', zone: 'right', distance: 1.7 }),
    ]);
    expect(text).toBe('Chair, right, about 1.5 metres. Person, left, about 4 metres.');
  });

  it('never says the way is clear', () => {
    expect(describeScene([])).toMatch(/does not mean the way is clear/);
  });
});
