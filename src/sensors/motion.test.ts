import { describe, expect, it } from 'vitest';
import { cameraElevationDeg, StepDetector } from './motion';

describe('camera tilt', () => {
  it('upright phone (portrait, camera forward) is level', () => {
    expect(cameraElevationDeg({ x: 0, y: 9.81, z: 0 })).toBeCloseTo(0, 5);
  });
  it('phone lying face up has the camera pointing at the floor', () => {
    expect(cameraElevationDeg({ x: 0, y: 0, z: 9.81 })).toBeCloseTo(-90, 5);
  });
  it('tilted 30 degrees forward points the camera 30 degrees down', () => {
    const a = (30 * Math.PI) / 180;
    expect(cameraElevationDeg({ x: 0, y: 9.81 * Math.cos(a), z: 9.81 * Math.sin(a) })).toBeCloseTo(-30, 3);
  });
});

describe('step detector', () => {
  const simulate = (stepsPerSec: number, seconds: number, amp: number) => {
    const d = new StepDetector();
    for (let t = 0; t <= seconds * 1000; t += 20) {
      d.push(9.81 + amp * Math.sin(2 * Math.PI * stepsPerSec * (t / 1000)), t);
    }
    return d.state(seconds * 1000);
  };

  it('detects normal walking (~1.8 steps/s) and estimates speed', () => {
    const s = simulate(1.8, 6, 3);
    expect(s.walking).toBe(true);
    expect(s.cadence).toBeGreaterThan(95);
    expect(s.cadence).toBeLessThan(120);
    expect(s.speed).toBeGreaterThan(0.9);
    expect(s.speed).toBeLessThan(1.4);
  });

  it('standing still or small sway is not walking', () => {
    expect(simulate(1.8, 6, 0.4).walking).toBe(false);
    const d = new StepDetector();
    for (let t = 0; t <= 5000; t += 20) d.push(9.81, t);
    expect(d.state(5000)).toEqual({ cadence: 0, walking: false, speed: 0 });
  });
});
