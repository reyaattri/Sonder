import { describe, expect, it } from 'vitest';
import { decodeYolox, nms, YOLOX_INPUT, yoloxGrid } from './yolox';

describe('YOLOX post-processing', () => {
  it('grid covers 416 input at strides 8/16/32 (3549 anchors)', () => {
    const g = yoloxGrid();
    expect(g.stride.length).toBe(52 * 52 + 26 * 26 + 13 * 13);
    expect(g.stride[0]).toBe(8);
    expect(g.stride[g.stride.length - 1]).toBe(32);
  });

  it('decodes a single confident person box back to normalized source coords', () => {
    const g = yoloxGrid();
    const out = new Float32Array(g.stride.length * 85);
    // Anchor at stride-32 cell (6, 6): center = (6 + 0.5) * 32 = 208, box 128 x 256.
    const i = 52 * 52 + 26 * 26 + 6 * 13 + 6;
    out.set([0.5, 0.5, Math.log(128 / 32), Math.log(256 / 32), 0.9], i * 85);
    out[i * 85 + 5 + 0] = 0.95; // class 0 = person
    // Source 832 x 832 letterboxed to 416 -> ratio 0.5
    const dets = decodeYolox(out, 832, 832, YOLOX_INPUT / 832);
    expect(dets).toHaveLength(1);
    expect(dets[0].label).toBe('person');
    expect(dets[0].score).toBeCloseTo(0.855, 3);
    expect(dets[0].box.x).toBeCloseTo((208 - 64) / 416, 4);
    expect(dets[0].box.h).toBeCloseTo(256 / 416, 4);
  });

  it('nms drops overlapping same-class boxes but keeps different classes', () => {
    const b = { x: 0.1, y: 0.1, w: 0.3, h: 0.5 };
    const kept = nms([
      { label: 'person', score: 0.9, box: b },
      { label: 'person', score: 0.8, box: { ...b, x: 0.11 } },
      { label: 'chair', score: 0.7, box: b },
    ]);
    expect(kept.map((d) => d.label)).toEqual(['person', 'chair']);
  });
});
