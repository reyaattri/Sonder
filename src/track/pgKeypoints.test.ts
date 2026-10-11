import { describe, expect, it } from 'vitest';
import { blockKeypoints } from './pgKeypoints';

describe('Project Guideline keypoint extraction (port)', () => {
  it('finds one keypoint per block along a vertical line, at the line', () => {
    const w = 64, h = 64;
    const mask = new Float32Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 40; x < 44; x++) mask[y * w + x] = 0.9;
    const kp = blockKeypoints(mask, w, h);
    expect(kp.length).toBeGreaterThan(3);
    for (const k of kp) expect(k.x).toBeCloseTo(42 / 64, 1);
    expect(kp[0].y).toBeLessThan(kp[kp.length - 1].y); // top to bottom
  });

  it('ignores weak, spurious blobs below the minimum confidence sum', () => {
    const w = 64, h = 64;
    const mask = new Float32Array(w * h);
    mask[10 * w + 5] = 0.9; // a single noisy pixel
    expect(blockKeypoints(mask, w, h)).toHaveLength(0);
  });
});
