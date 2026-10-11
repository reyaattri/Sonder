import type { Category } from '../core/types';
import { closeness, spreadAzimuth } from './geometry';
import type { Track } from './tracker';

/** One thing in the 360-degree sound scene. */
export interface SceneObject {
  key: string;
  kind: Category;
  label: string;
  /** Radians relative to where you face: 0 ahead, +90deg right, +-180deg behind. */
  azimuth: number;
  elevation: number;
  distance: number;
  /** 0..1 loudness weight (near = 1). */
  presence: number;
  /** Out of the camera's view: carried on from memory. */
  remembered: boolean;
}

interface Memory {
  kind: Category;
  label: string;
  /** World bearing (radians, clockwise from where you faced at start). */
  worldAz: number;
  /** Bearing change rate while last seen (rad/s), for carrying motion on. */
  azVel: number;
  elevation: number;
  distance: number;
  lastSeen: number;
  presence: number;
}

const MEMORY_MS = 3000;
const MAX_OBJECTS = 6;
const MAX_RANGE_M = 8;
const MAX_BEHIND = (170 * Math.PI) / 180;

/**
 * Keeps a 360-degree picture of what's around you. Objects in view sit at
 * their (widened) camera bearing. When one leaves the frame, it isn't
 * forgotten: it keeps moving the way it was going (round to your side and
 * behind you) and fades over 3 s. Bearings are held in WORLD terms using the
 * phone's turn rate, so when you turn, remembered things stay where they are.
 */
export class SceneMemory {
  private mem = new Map<number, Memory>();
  private lastT = 0;

  reset(): void {
    this.mem.clear();
  }

  update(tracks: readonly Track[], now: number, yaw: number, spread: number): SceneObject[] {
    const dt = this.lastT ? (now - this.lastT) / 1000 : 0;
    this.lastT = now;
    const seen = new Set<number>();
    const out: SceneObject[] = [];
    for (const t of tracks) {
      if (!t.confirmed || t.distance > MAX_RANGE_M || t.lastSeen < now - 50) continue;
      seen.add(t.id);
      const az = spreadAzimuth(t.azimuth, spread);
      const worldAz = az + yaw;
      const m = this.mem.get(t.id);
      const azVel = m && dt > 0 ? m.azVel + 0.3 * ((worldAz - m.worldAz) / dt - m.azVel) : 0;
      const presence = 0.25 + 0.75 * closeness(t.distance);
      this.mem.set(t.id, {
        kind: t.category,
        label: t.label,
        worldAz,
        azVel,
        elevation: t.elevation ?? 0,
        distance: t.distance,
        lastSeen: now,
        presence,
      });
      out.push({ key: `s${t.id}`, kind: t.category, label: t.label, azimuth: az, elevation: t.elevation ?? 0, distance: t.distance, presence, remembered: false });
    }
    for (const [id, m] of this.mem) {
      if (seen.has(id)) continue;
      const age = (now - m.lastSeen) / 1000;
      if (age * 1000 > MEMORY_MS) {
        this.mem.delete(id);
        continue;
      }
      // Carry on its motion only if it was clearly moving sideways (passing you).
      const drift = Math.abs(m.azVel) > 0.15 ? m.azVel * age : 0;
      let az = m.worldAz + drift - yaw;
      az = Math.max(-MAX_BEHIND, Math.min(MAX_BEHIND, az));
      out.push({
        key: `s${id}`,
        kind: m.kind,
        label: m.label,
        azimuth: az,
        elevation: m.elevation,
        distance: m.distance,
        presence: m.presence * (1 - age / (MEMORY_MS / 1000)),
        remembered: true,
      });
    }
    return out.sort((a, b) => b.presence - a.presence).slice(0, MAX_OBJECTS);
  }
}

/**
 * Synthetic room impulse response for externalisation (sounds feel "out
 * there" rather than inside your head): a few early reflections, then a
 * decorrelated, darkening exponential tail. Different per channel so the
 * reverb is wide.
 */
export function makeImpulse(sampleRate: number, seconds = 1.1, seed = 1): [Float32Array, Float32Array] {
  const n = Math.floor(sampleRate * seconds);
  const L = new Float32Array(n), R = new Float32Array(n);
  let s = seed;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647) * 2 - 1;
  const tau = seconds / 4.5;
  let lpL = 0, lpR = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    const env = Math.exp(-t / tau);
    const k = 0.25 + 0.6 * Math.min(1, t / seconds); // darker as it decays
    lpL += k * (rnd() - lpL);
    lpR += k * (rnd() - lpR);
    L[i] = lpL * env;
    R[i] = lpR * env;
  }
  for (const [ms, g, ch] of [
    [7, 0.5, L],
    [11, 0.45, R],
    [17, 0.3, L],
    [23, 0.3, R],
  ] as [number, number, Float32Array][]) {
    const i = Math.floor((ms / 1000) * sampleRate);
    if (i < n) ch[i] += g;
  }
  return [L, R];
}
