import { describe, expect, it } from 'vitest';
import { spreadAzimuth } from './engine';

const deg = (d: number) => (d * Math.PI) / 180;

describe('spatial direction widening', () => {
  it('something at the camera edge (~30 deg) is placed well to the side', () => {
    expect(spreadAzimuth(deg(30), 2.2)).toBeCloseTo(deg(66), 6);
    expect(spreadAzimuth(deg(-30), 2.2)).toBeCloseTo(deg(-66), 6);
  });
  it('straight ahead stays straight ahead, and spread 1 is physically accurate', () => {
    expect(spreadAzimuth(0, 2.2)).toBe(0);
    expect(spreadAzimuth(deg(20), 1)).toBeCloseTo(deg(20), 6);
  });
  it('never swings past 80 deg (would sound like it is behind you)', () => {
    expect(spreadAzimuth(deg(40), 3)).toBeCloseTo(deg(80), 6);
  });
});
