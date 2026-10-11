import { describe, expect, it } from 'vitest';
import { applyShaping, steerPan, warningPan } from './pgSounds';

describe('Project Guideline sound mapping', () => {
  it('sensitivity shaping keeps small corrections small, big ones full', () => {
    expect(applyShaping(0)).toBe(0);
    expect(Math.abs(applyShaping(0.2))).toBeLessThan(0.2); // quieter than linear
    expect(applyShaping(1)).toBeCloseTo(1, 6);
    expect(applyShaping(-1)).toBeCloseTo(-1, 6);
    expect(applyShaping(0.3)).toBeCloseTo(-applyShaping(-0.3), 6);
  });

  it('steering sound (and ear vibration) is in the ear of the side to turn toward', () => {
    const [l, r] = steerPan(0.8); // turn right
    expect(r).toBeGreaterThan(0.7);
    expect(l).toBe(0);
    const [l2, r2] = steerPan(-0.8); // turn left
    expect(l2).toBeGreaterThan(0.7);
    expect(r2).toBe(0);
  });

  it('warning is silent until 40 % of the warning distance, then in the ear to move toward', () => {
    expect(warningPan(0.3)).toEqual([0, 0]);
    const [l, r] = warningPan(0.9); // you are right of the line -> move left
    expect(l).toBeGreaterThan(0.7);
    expect(r).toBe(0);
  });
});
