import type { Zone } from '../core/types';
import type { Gray } from './imageStats';

/**
 * Locust-inspired looming detector (LGMD: Lobula Giant Movement Detector).
 *
 * A second visual pathway that ignores WHAT an object is and responds to the
 * signature of something rushing toward the camera: edges that expand and
 * accelerate. It catches what the semantic detector can't name (poles, doors,
 * branches, a cyclist it missed). Structure after Yue & Rind (2006):
 *
 *   P (photoreceptors)  = |luminance change| per cell
 *   I (inhibition)      = last frame's P spread to neighbours (delayed, lateral)
 *   S (summation)       = P - w_i * I          (excitation that outran inhibition)
 *   G (grouping)        = S where its neighbourhood is also excited (kills speckle)
 *   K (membrane)        = mean G per sector
 *   FFI                 = whole-field change too large (camera shake, lighting) -> suppress
 *
 * Compound-eye sectors: left / center / right each have their own unit, so a
 * looming threat also has a direction. Approach is told apart from sideways
 * motion by K RISING over consecutive frames (an approaching edge grows and
 * speeds up; a passing one doesn't), relative to an adaptive baseline of
 * background motion, AND by geometry: looming excitation spreads outward from
 * a fixed point (its spatial spread grows faster than its centre moves),
 * while a passing object's excitation slides across.
 */

const W_I = 0.7;
const INHIBIT = [
  [0.125, 0.25, 0.125],
  [0.25, 0, 0.25],
  [0.125, 0.25, 0.125],
];
const FFI_LIMIT = 22; // mean |change| above this = whole-field event
const SPIKE_Z = 3;
const ABS_MIN = 0.6;
const RISE_FRAMES = 3;

export const SECTORS: Zone[] = ['left', 'center', 'right'];

export interface SectorState {
  k: number;
  z: number;
  spike: boolean;
  looming: boolean;
}

export interface LgmdOutput {
  sectors: Record<Zone, SectorState>;
  /** Feed-forward inhibition fired (whole-field change ignored this frame). */
  ffi: boolean;
  /** Strongest looming sector, if any. */
  looming: Zone | null;
  /** 0..1 strength of the strongest looming response. */
  strength: number;
}

interface Unit {
  mean: number;
  varr: number;
  hist: number[];
  spikes: boolean[];
  /** Excitation centroid and spread per frame (cells). */
  geo: { cx: number; cy: number; spread: number }[];
}

const freshUnit = (): Unit => ({ mean: 0, varr: 0.25, hist: [], spikes: [], geo: [] });

/** Expanding from a point (looming) rather than sliding across (passing)? */
export function isExpanding(geo: { cx: number; cy: number; spread: number }[]): boolean {
  if (geo.length < 3) return false;
  const a = geo[0], b = geo[geo.length - 1];
  const grow = b.spread - a.spread;
  const shift = Math.hypot(b.cx - a.cx, b.cy - a.cy);
  return grow > 0.5 && shift < grow;
}

export class LgmdDetector {
  private prevL: Float32Array | null = null;
  private prevP: Float32Array | null = null;
  private units: Record<Zone, Unit> = { left: freshUnit(), center: freshUnit(), right: freshUnit() };
  private frames = 0;

  reset(): void {
    this.prevL = this.prevP = null;
    this.units = { left: freshUnit(), center: freshUnit(), right: freshUnit() };
    this.frames = 0;
  }

  /** `sensitivity` > 1 makes it harder to trigger (e.g. while walking). */
  update(g: Gray, sensitivity = 1): LgmdOutput {
    const { data: L, width: w, height: h } = g;
    const empty = (): LgmdOutput => ({
      sectors: {
        left: { k: 0, z: 0, spike: false, looming: false },
        center: { k: 0, z: 0, spike: false, looming: false },
        right: { k: 0, z: 0, spike: false, looming: false },
      },
      ffi: false,
      looming: null,
      strength: 0,
    });
    if (!this.prevL || this.prevL.length !== L.length) {
      this.prevL = Float32Array.from(L);
      this.prevP = new Float32Array(L.length);
      return empty();
    }
    // P layer
    const P = new Float32Array(L.length);
    let total = 0;
    for (let i = 0; i < L.length; i++) {
      P[i] = Math.abs(L[i] - this.prevL[i]);
      total += P[i];
    }
    const ffi = total / L.length > FFI_LIMIT;
    // I and S layers
    const S = new Float32Array(L.length);
    const prevP = this.prevP!;
    for (let y = 1; y < h - 1; y++)
      for (let x = 1; x < w - 1; x++) {
        let inh = 0;
        for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) inh += prevP[(y + j) * w + x + i] * INHIBIT[j + 1][i + 1];
        const s = P[y * w + x] - W_I * inh;
        S[y * w + x] = s > 0 ? s : 0;
      }
    // G layer + per-sector membrane potential
    const sums: Record<Zone, number> = { left: 0, center: 0, right: 0 };
    const counts: Record<Zone, number> = { left: 0, center: 0, right: 0 };
    const mom: Record<Zone, [number, number, number, number, number]> = {
      left: [0, 0, 0, 0, 0],
      center: [0, 0, 0, 0, 0],
      right: [0, 0, 0, 0, 0],
    };
    for (let y = 1; y < h - 1; y++)
      for (let x = 1; x < w - 1; x++) {
        const sec: Zone = x < w / 3 ? 'left' : x < (2 * w) / 3 ? 'center' : 'right';
        counts[sec]++;
        const s = S[y * w + x];
        if (s <= 0) continue;
        let ce = 0;
        for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) ce += S[(y + j) * w + x + i];
        if (ce / 9 > 4) {
          // grouped (coherent) excitation only
          sums[sec] += s;
          const m = mom[sec];
          m[0] += s;
          m[1] += s * x;
          m[2] += s * y;
          m[3] += s * x * x;
          m[4] += s * y * y;
        }
      }
    this.prevL.set(L);
    this.prevP = P;
    this.frames++;

    const out = empty();
    out.ffi = ffi;
    let best: Zone | null = null, bestZ = 0;
    for (const sec of SECTORS) {
      const u = this.units[sec];
      const k = sums[sec] / Math.max(1, counts[sec]);
      const std = Math.sqrt(Math.max(u.varr, 0.04));
      const z = (k - u.mean) / std;
      const spike = !ffi && this.frames > 3 && k > ABS_MIN * sensitivity && z > SPIKE_Z * sensitivity;
      u.hist.push(k);
      if (u.hist.length > RISE_FRAMES + 1) u.hist.shift();
      u.spikes.push(spike);
      if (u.spikes.length > 4) u.spikes.shift();
      const [m0, mx, my, mxx, myy] = mom[sec];
      if (m0 > 0) {
        const cx = mx / m0, cy = my / m0;
        const spread = Math.sqrt(Math.max(0, mxx / m0 - cx * cx + myy / m0 - cy * cy));
        u.geo.push({ cx, cy, spread });
      } else {
        u.geo = [];
      }
      if (u.geo.length > RISE_FRAMES + 1) u.geo.shift();
      // Background motion level adapts only on quiet frames, so a threat
      // doesn't teach the detector to ignore itself.
      if (!spike && !ffi) {
        const d = k - u.mean;
        u.mean += 0.08 * d;
        u.varr += 0.08 * (d * d - u.varr);
      }
      const rising = u.hist.length > RISE_FRAMES && u.hist.every((v, i, a) => i === 0 || v >= a[i - 1] * 0.98);
      const looming = rising && u.spikes.filter(Boolean).length >= 3 && isExpanding(u.geo);
      out.sectors[sec] = { k, z, spike, looming };
      if (looming && z > bestZ) [best, bestZ] = [sec, z];
    }
    out.looming = best;
    out.strength = best ? Math.min(1, bestZ / (SPIKE_Z * 4)) : 0;
    return out;
  }
}
