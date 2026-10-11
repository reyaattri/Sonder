/**
 * Line keypoints from a segmentation confidence mask - a port of Project
 * Guideline's ExtractHorizontalBlockBasedKeypoint (vision/keypoint_extraction.cc):
 * slice the mask into overlapping horizontal blocks; in each block, the
 * confidence-weighted centroid of pixels >= 0.5 is one keypoint, kept if the
 * block's total confidence is above a minimum, with confidence = sum / high.
 */
export interface MaskKeypoint {
  /** Normalised 0..1 image coordinates. */
  x: number;
  y: number;
  confidence: number;
}

export function blockKeypoints(
  mask: Float32Array,
  w: number,
  h: number,
  blockSize = 16,
  blockOverlap = 4,
  minSum = 2,
  highSum = 10,
): MaskKeypoint[] {
  const out: MaskKeypoint[] = [];
  const n = Math.floor(h / (blockSize - blockOverlap));
  if (n < 2) return out;
  const start = -blockOverlap, end = h - blockOverlap;
  const inc = (end - start) / (n - 1);
  for (let i = 0; i < n; i++) {
    const r0 = Math.max(Math.round(start + i * inc), 0);
    const r1 = Math.min(Math.round(start + i * inc) + blockSize, h);
    let sum = 0, cx = 0, cy = 0;
    for (let y = r0; y < r1; y++)
      for (let x = 0; x < w; x++) {
        const v = mask[y * w + x];
        if (v < 0.5) continue;
        sum += v;
        cx += x * v;
        cy += y * v;
      }
    if (sum > minSum) out.push({ x: (cx / sum + 0.5) / w, y: (cy / sum + 0.5) / h, confidence: Math.min(1, sum / highSum) });
  }
  return out;
}
