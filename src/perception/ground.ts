/**
 * Ground hazards you can't feel coming with a cane tip until you're on them:
 * fallen-leaf litter (slippery when wet, hides kerbs and holes).
 *
 * Works on a small camera thumbnail in real time, no ML: the ground area is
 * cut into cells; each gets a colour (warmth, greenness, saturation) and a
 * texture measure (mean luma gradient). Paths are smooth and grey; leaf
 * litter is busy and warm (brown / orange / beige); grass is green. The
 * texture threshold adapts to the surface you're walking on (its median
 * texture), the way the path model adapts to its colour.
 */

export const GCOLS = 16;
export const GROWS = 10;
/** Ground region: from this fraction of the image height down. */
export const G_TOP = 0.42;

export interface GroundMap {
  /** 1 = leaf litter, per cell, row-major (row 0 = farthest). */
  leaves: Uint8Array;
  /** Fraction of the walking corridor (centre third, near half) covered by leaves. */
  corridor: number;
  /** Where the leaves in your way are (0..1 across the image), or null. */
  aheadX: number | null;
  /** Leaves along the left / right edge of the view. */
  left: number;
  right: number;
}

interface Cell {
  r: number;
  g: number;
  b: number;
  tex: number;
}

function cells(px: Uint8ClampedArray, w: number, h: number): Cell[] {
  const out: Cell[] = [];
  const y0 = Math.floor(h * G_TOP);
  const ch = (h - y0) / GROWS, cw = w / GCOLS;
  for (let r = 0; r < GROWS; r++)
    for (let c = 0; c < GCOLS; c++) {
      const ya = Math.floor(y0 + r * ch), yb = Math.max(ya + 2, Math.floor(y0 + (r + 1) * ch));
      const xa = Math.floor(c * cw), xb = Math.max(xa + 2, Math.floor((c + 1) * cw));
      let R = 0, G = 0, B = 0, T = 0, n = 0, tn = 0;
      for (let y = ya; y < Math.min(h, yb); y++)
        for (let x = xa; x < Math.min(w, xb); x++) {
          const i = (y * w + x) * 4;
          R += px[i];
          G += px[i + 1];
          B += px[i + 2];
          n++;
          if (x + 1 < w && y + 1 < h) {
            const l = px[i] + px[i + 1] + px[i + 2];
            const lr = px[i + 4] + px[i + 5] + px[i + 6];
            const ld = px[i + w * 4] + px[i + w * 4 + 1] + px[i + w * 4 + 2];
            T += Math.abs(l - lr) + Math.abs(l - ld);
            tn++;
          }
        }
      out.push({ r: R / n, g: G / n, b: B / n, tex: tn ? T / tn / 3 : 0 });
    }
  return out;
}

const median = (a: number[]) => {
  const s = [...a].sort((x, y) => x - y);
  return s.length ? s[Math.floor(s.length / 2)] : 0;
};

/** Leaf-litter map for one frame (RGBA thumbnail, ideally 120-200 px wide). */
export function groundMap(px: Uint8ClampedArray, w: number, h: number): GroundMap {
  const cs = cells(px, w, h);
  // Reference surface: the near, central cells (where you're about to step).
  const ref: number[] = [];
  for (let r = GROWS - 3; r < GROWS; r++) for (let c = 5; c < GCOLS - 5; c++) ref.push(cs[r * GCOLS + c].tex);
  const refTex = median(ref);
  const leaves = new Uint8Array(GCOLS * GROWS);
  cs.forEach((k, i) => {
    const mx = Math.max(k.r, k.g, k.b), mn = Math.min(k.r, k.g, k.b);
    const sat = mx > 0 ? (mx - mn) / mx : 0;
    const warm = k.r - k.b; // brown, orange, beige, tan
    const green = k.g - Math.max(k.r, k.b);
    const busy = k.tex > Math.max(9, refTex * 1.8);
    const warmish = warm > 6 && k.r >= k.g - 4 && green < 4 && sat > 0.06 && mx > 45;
    if (busy && warmish) leaves[i] = 1;
  });
  // Lone cells are noise: keep cells with at least one leafy neighbour.
  const keep = new Uint8Array(leaves.length);
  for (let r = 0; r < GROWS; r++)
    for (let c = 0; c < GCOLS; c++) {
      if (!leaves[r * GCOLS + c]) continue;
      let nb = 0;
      for (const [dr, dc] of [[-1, 0], [1, 0], [0, -1], [0, 1]])
        if (r + dr >= 0 && r + dr < GROWS && c + dc >= 0 && c + dc < GCOLS) nb += leaves[(r + dr) * GCOLS + c + dc];
      if (nb > 0) keep[r * GCOLS + c] = 1;
    }
  const c0 = Math.floor(GCOLS / 3), c1 = Math.ceil((2 * GCOLS) / 3);
  let inC = 0, nC = 0, sx = 0, sn = 0, left = 0, right = 0;
  for (let r = Math.floor(GROWS / 2); r < GROWS; r++)
    for (let c = 0; c < GCOLS; c++) {
      const v = keep[r * GCOLS + c];
      if (c >= c0 && c < c1) {
        nC++;
        if (v) {
          inC++;
          sx += (c + 0.5) / GCOLS;
          sn++;
        }
      } else if (c < c0) left += v;
      else right += v;
    }
  const sideN = c0 * Math.ceil(GROWS / 2);
  return {
    leaves: keep,
    corridor: nC ? inC / nC : 0,
    aheadX: sn ? sx / sn : null,
    left: sideN ? left / sideN : 0,
    right: sideN ? right / sideN : 0,
  };
}
