import { describe, expect, it } from 'vitest';
import { LANE_W, road, roadLineY, stadium, stepRunner, wrap } from './course';

describe('400 m stadium', () => {
  const c = stadium(3);
  it('starts in the centre of lane 3 on the home straight, heading along it', () => {
    const s = c.start();
    expect(c.lateral(s.x, s.y)).toBeCloseTo(0, 6);
    expect(c.tangent(s.x, s.y)).toBeCloseTo(s.heading, 6);
  });

  it('lane lines are 1.22 m apart, white; grass inside', () => {
    const s = c.start();
    expect(c.paintAt(s.x, s.y)).toBe('track');
    expect(c.paintAt(s.x, s.y + LANE_W / 2)).toBe('white'); // inner line of lane 3 (to the left)
    expect(c.paintAt(s.x, s.y - LANE_W / 2)).toBe('white'); // outer line (to the right)
    expect(c.paintAt(0, 0)).toBe('grass');
  });

  it('lateral: further out = to your right (+)', () => {
    const s = c.start();
    expect(c.lateral(s.x, s.y - 0.3)).toBeCloseTo(0.3, 6);
  });

  it('a runner steering exactly along the bend stays in lane round the curve', () => {
    let r = { ...c.start(), speed: 4, turnRate: 0, distance: 0 };
    const dt = 0.02;
    let worst = 0;
    for (let i = 0; i < 4000; i++) {
      const err = wrap(c.tangent(r.x, r.y) - r.heading);
      r = stepRunner(r, -err * 4 - 1.5 * c.lateral(r.x, r.y), dt); // follow the bend and correct drift
      worst = Math.max(worst, Math.abs(c.lateral(r.x, r.y)));
    }
    expect(r.distance).toBeGreaterThan(300);
    expect(worst).toBeLessThan(0.3);
  });
});

describe('road with guide line', () => {
  const c = road();
  it('starts on the yellow line', () => {
    const s = c.start();
    expect(c.paintAt(s.x, s.y)).toBe('yellow');
    expect(c.lateral(s.x, s.y)).toBeCloseTo(0, 6);
  });
  it('right of the line is positive', () => {
    expect(c.lateral(10, roadLineY(10) - 0.5)).toBeGreaterThan(0.4);
  });
});
