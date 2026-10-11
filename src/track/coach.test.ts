import { describe, expect, it } from 'vitest';
import { LapTimer, PaceCoach, StopGuard } from './coach';

describe('lap splits', () => {
  it('announces each lap with the comparison to the last', () => {
    const l = new LapTimer();
    expect(l.update(0, 50)).toBeNull();
    expect(l.update(1, 95)).toBe('Lap 1, 1 minute 35.');
    expect(l.update(1, 120)).toBeNull();
    expect(l.update(2, 187)).toBe('Lap 2, 1 minute 32. 3 seconds faster.');
    expect(l.update(3, 280.5)).toBe('Lap 3, 1 minute 34. 2 seconds slower.');
    expect(l.best).toBeCloseTo(92, 5);
  });
});

describe('pace coach', () => {
  it('silent on pace; nudges when off by more than 3%, at most every 30 s', () => {
    const c = new PaceCoach();
    expect(c.update(300, 300, 0)).toBeNull();
    expect(c.update(320, 300, 10)).toBe('20 seconds per kilometre slow. Pick it up a little.');
    expect(c.update(320, 300, 20)).toBeNull();
    expect(c.update(280, 300, 45)).toBe('20 seconds per kilometre fast. Ease off a little.');
    expect(c.update(320, 0, 100)).toBeNull(); // no target set
  });
});

describe('STOP guard (guide-line style)', () => {
  it('lost line while moving -> STOP after 1.5 s, repeated every 3 s, then GO when found', () => {
    const g = new StopGuard();
    expect(g.update(true, 0, true, 0)).toBeNull();
    expect(g.update(true, 0, true, 1600)).toBe('stop');
    expect(g.update(true, 0, true, 2600)).toBeNull();
    expect(g.update(true, 0, true, 4700)).toBe('stop');
    expect(g.update(false, 0.1, true, 5000)).toBe('go');
    expect(g.update(false, 0.1, true, 5100)).toBeNull();
  });

  it('standing still with no line is not a STOP; leaving the lane is', () => {
    const g = new StopGuard();
    expect(g.update(true, 0, false, 5000)).toBeNull();
    expect(g.update(false, 0.7, true, 6000)).toBe('stop');
  });
});

describe('STOP guard on a single painted line', () => {
  it('a 1 m drift off a painted line is guidance, not STOP; 1.6 m is STOP', () => {
    const g = new StopGuard();
    const lim = (1.5 / 0.5) * 0.5; // as track mode computes it for a line course
    expect(g.update(false, 1.0, true, 0, lim)).toBeNull();
    expect(g.update(false, 1.6, true, 100, lim)).toBe('stop');
  });
});
