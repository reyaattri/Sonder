import { describe, expect, it } from 'vitest';
import { QualityGovernor, qualityLadder } from './governor';
import { FpsMeter, Rolling } from './metrics';

describe('quality governor', () => {
  it('ladder steps resolution down first, then model size', () => {
    const l = qualityLadder('efficientdet_lite2');
    expect(l.map((x) => `${x.model}@${x.inputWidth}`)).toEqual([
      'efficientdet_lite2@640',
      'efficientdet_lite2@480',
      'efficientdet_lite2@320',
      'efficientdet_lite0@480',
      'efficientdet_lite0@320',
    ]);
  });

  it('steps down after 3 s below 12 FPS, tells the user once, steps back up when stable', () => {
    const g = new QualityGovernor(qualityLadder('efficientdet_lite0'));
    expect(g.update(8, 0)).toBeNull();
    expect(g.update(8, 2900)).toBeNull();
    const down = g.update(8, 3000);
    expect(down).toMatchObject({ kind: 'down', firstDown: true, level: { inputWidth: 480 } });
    const down2 = g.update(8, 6100);
    expect(down2).toMatchObject({ kind: 'down', firstDown: false, level: { inputWidth: 320 } });
    expect(g.update(8, 9999)).toBeNull(); // already at the bottom
    expect(g.update(25, 10000)).toBeNull();
    expect(g.update(25, 20000)).toMatchObject({ kind: 'up', level: { inputWidth: 480 } });
  });

  it('a brief dip does not trigger a step down', () => {
    const g = new QualityGovernor(qualityLadder('efficientdet_lite0'));
    g.update(8, 0);
    g.update(15, 1500);
    expect(g.update(8, 3200)).toBeNull();
  });
});

describe('metrics', () => {
  it('percentiles', () => {
    const r = new Rolling(100);
    for (let i = 1; i <= 100; i++) r.push(i);
    expect(r.percentile(50)).toBe(50);
    expect(r.percentile(95)).toBe(95);
  });

  it('fps over a window', () => {
    const m = new FpsMeter(2000);
    for (let i = 0; i <= 30; i++) m.tick(i * 50);
    expect(m.fps(1500)).toBeCloseTo(20, 5);
  });
});
