/**
 * Live run metrics for one athlete: time, distance, pace, cadence, heart
 * rate, laps. Distance comes from GPS outdoors, or from steps x step length
 * when GPS is unavailable (indoor tracks). Everything stays on the device.
 */

export interface GeoFix {
  lat: number;
  lon: number;
  accuracy: number;
  t: number;
  /** m/s from the device, if provided. */
  speed: number | null;
}

const R_EARTH = 6371000;

export function haversine(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const toR = Math.PI / 180;
  const dLat = (b.lat - a.lat) * toR, dLon = (b.lon - a.lon) * toR;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * toR) * Math.cos(b.lat * toR) * Math.sin(dLon / 2) ** 2;
  return 2 * R_EARTH * Math.asin(Math.sqrt(s));
}

/** Accumulates GPS distance, rejecting inaccurate fixes and impossible jumps. */
export class GpsDistance {
  distance = 0;
  speed = 0;
  lastAccuracy = Infinity;
  private last: GeoFix | null = null;

  reset(): void {
    this.distance = 0;
    this.speed = 0;
    this.last = null;
  }

  push(f: GeoFix): void {
    this.lastAccuracy = f.accuracy;
    if (f.accuracy > 25) return; // too vague to use
    if (!this.last) {
      this.last = f;
      return;
    }
    const d = haversine(this.last, f);
    const dt = (f.t - this.last.t) / 1000;
    if (dt <= 0) return;
    const v = d / dt;
    if (v > 12) return; // faster than an elite sprinter: a GPS jump
    // Ignore jitter while standing still: require movement beyond the noise.
    if (d < Math.max(1.5, Math.min(f.accuracy, 8) * 0.3)) {
      if (dt > 3) this.speed *= 0.5;
      return;
    }
    this.distance += d;
    const inst = f.speed ?? v;
    this.speed = this.speed ? this.speed + 0.4 * (inst - this.speed) : inst;
    this.last = f;
  }

  get usable(): boolean {
    return this.lastAccuracy <= 25;
  }
}

/** Bluetooth Heart Rate Measurement (0x2A37): flags bit 0 = 16-bit value. */
export function parseHeartRate(view: DataView): number {
  const flags = view.getUint8(0);
  return flags & 1 ? view.getUint16(1, true) : view.getUint8(1);
}

export interface RunSnapshot {
  elapsedS: number;
  distanceM: number;
  /** m/s */
  speed: number;
  /** seconds per km; Infinity when not moving */
  paceS: number;
  cadence: number;
  heartRate: number | null;
  laps: number;
  source: 'gps' | 'steps';
}

export function formatDuration(s: number): string {
  s = Math.max(0, Math.round(s));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
}

export function formatPace(paceS: number): string {
  if (!Number.isFinite(paceS) || paceS > 1800) return '–';
  return formatDuration(paceS);
}

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

function spokenDuration(s: number): string {
  s = Math.round(s);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  const parts = [];
  if (h) parts.push(plural(h, 'hour'));
  if (m) parts.push(plural(m, 'minute'));
  if (sec || parts.length === 0) parts.push(plural(sec, 'second'));
  return parts.join(' ');
}

/** What the runner hears: short, numbers first, most useful first. */
export function runSummary(r: RunSnapshot, lead = ''): string {
  const km = r.distanceM / 1000;
  const parts = [lead];
  parts.push(km >= 1 ? `${km.toFixed(2)} kilometres` : `${Math.round(r.distanceM)} metres`);
  parts.push(`in ${spokenDuration(r.elapsedS)}.`);
  if (Number.isFinite(r.paceS) && r.paceS < 1800) {
    const m = Math.floor(r.paceS / 60), s = Math.round(r.paceS % 60);
    parts.push(`Pace ${m} ${s < 10 ? 'oh ' : ''}${s} per kilometre.`);
  }
  if (r.cadence > 0) parts.push(`Cadence ${Math.round(r.cadence)}.`);
  if (r.heartRate) parts.push(`Heart rate ${r.heartRate}.`);
  return parts.filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
}

/** Decides when to speak stats: each lap, each km, or every N minutes. */
export class AnnounceSchedule {
  private lastLap = 0;
  private lastKm = 0;
  private lastTime = 0;

  reset(): void {
    this.lastLap = this.lastKm = this.lastTime = 0;
  }

  due(r: RunSnapshot, mode: 'lap' | 'km' | 'time' | 'off', minutes: number): string | null {
    if (mode === 'lap' && r.laps > this.lastLap) {
      this.lastLap = r.laps;
      return `Lap ${r.laps}.`;
    }
    const km = Math.floor(r.distanceM / 1000);
    if (mode === 'km' && km > this.lastKm) {
      this.lastKm = km;
      return `${plural(km, 'kilometre')}.`;
    }
    if (mode === 'time' && r.elapsedS - this.lastTime >= minutes * 60) {
      this.lastTime = r.elapsedS - (r.elapsedS % (minutes * 60));
      return '';
    }
    return null;
  }
}
