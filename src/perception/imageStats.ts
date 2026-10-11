/**
 * Cheap whole-frame checks on a tiny grayscale thumbnail (e.g. 64x48):
 * brightness and sharpness for the low-light warning. (Looming now lives in
 * lgmd.ts; `expansion` is kept as a simple zoom estimator.)
 */
export interface Gray {
  data: Float32Array;
  width: number;
  height: number;
}

export function toGray(rgba: Uint8ClampedArray, width: number, height: number): Gray {
  const data = new Float32Array(width * height);
  for (let i = 0, j = 0; j < data.length; i += 4, j++) {
    data[j] = 0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2];
  }
  return { data, width, height };
}

export function meanLuma(g: Gray): number {
  let s = 0;
  for (const v of g.data) s += v;
  return s / g.data.length;
}

/** Variance of the Laplacian: low values mean a blurry (or featureless) frame. */
export function sharpness(g: Gray): number {
  const { data, width: w, height: h } = g;
  let s = 0, s2 = 0, n = 0;
  for (let y = 1; y < h - 1; y++)
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const l = data[i - 1] + data[i + 1] + data[i - w] + data[i + w] - 4 * data[i];
      s += l;
      s2 += l * l;
      n++;
    }
  const m = s / n;
  return s2 / n - m * m;
}

export type FrameQuality = 'ok' | 'dark' | 'blurry';

export const DARK_LUMA = 35;
export const BLUR_VAR = 12;

export function frameQuality(g: Gray): FrameQuality {
  if (meanLuma(g) < DARK_LUMA) return 'dark';
  if (sharpness(g) < BLUR_VAR) return 'blurry';
  return 'ok';
}

function sample(g: Gray, x: number, y: number): number {
  const x0 = Math.max(0, Math.min(g.width - 2, Math.floor(x)));
  const y0 = Math.max(0, Math.min(g.height - 2, Math.floor(y)));
  const fx = Math.min(1, Math.max(0, x - x0));
  const fy = Math.min(1, Math.max(0, y - y0));
  const i = y0 * g.width + x0;
  const d = g.data;
  return (
    d[i] * (1 - fx) * (1 - fy) +
    d[i + 1] * fx * (1 - fy) +
    d[i + g.width] * (1 - fx) * fy +
    d[i + g.width + 1] * fx * fy
  );
}

const SCALES = [1, 1.02, 1.04, 1.07, 1.1];

/**
 * Best zoom factor s mapping the previous frame onto the current one, over
 * the central region. s > 1 means the scene is expanding (we are closing in).
 * Returns s and how much better it fits than "no change".
 */
export function expansion(prev: Gray, cur: Gray): { scale: number; gain: number } {
  const { width: w, height: h } = cur;
  const cx = w / 2, cy = h / 2;
  const x0 = Math.floor(w * 0.25), x1 = Math.ceil(w * 0.75);
  const y0 = Math.floor(h * 0.2), y1 = Math.ceil(h * 0.8);
  let mp = 0, mc = 0, n = 0;
  for (let y = y0; y < y1; y++)
    for (let x = x0; x < x1; x++) {
      mp += prev.data[y * w + x];
      mc += cur.data[y * w + x];
      n++;
    }
  const off = mc / n - mp / n; // ignore exposure changes
  const errs = SCALES.map((s) => {
    let e = 0;
    for (let y = y0; y < y1; y++)
      for (let x = x0; x < x1; x++) {
        const p = sample(prev, cx + (x - cx) / s, cy + (y - cy) / s);
        e += Math.abs(cur.data[y * w + x] - p - off);
      }
    return e / n;
  });
  let best = 0;
  for (let i = 1; i < errs.length; i++) if (errs[i] < errs[best]) best = i;
  return { scale: SCALES[best], gain: errs[0] > 0 ? 1 - errs[best] / errs[0] : 0 };
}
