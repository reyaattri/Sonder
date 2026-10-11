import type { MotionSensor } from '../sensors/motion';
import { AnnounceSchedule, GpsDistance, type RunSnapshot } from './run';

/**
 * Combines GPS and step count into live run metrics. Time
 * excludes pauses. When GPS is poor (indoors), distance = steps x step length.
 */
export class RunTracker {
  readonly gps = new GpsDistance();
  readonly schedule = new AnnounceSchedule();
  gpsState: 'off' | 'waiting' | 'ok' | 'denied' | 'unavailable' = 'off';
  private watchId: number | null = null;
  private startAt = 0;
  private pausedTotal = 0;
  private pausedAt: number | null = null;
  private stepsAtStart = 0;
  private stepDistance = 0;

  constructor(private readonly motion: MotionSensor) {}

  start(): void {
    this.gps.reset();
    this.schedule.reset();
    this.startAt = performance.now();
    this.pausedTotal = 0;
    this.pausedAt = null;
    this.stepsAtStart = this.motion.totalSteps;
    this.stepDistance = 0;
    if (!('geolocation' in navigator)) {
      this.gpsState = 'unavailable';
      return;
    }
    this.gpsState = 'waiting';
    this.watchId = navigator.geolocation.watchPosition(
      (p) => {
        if (this.pausedAt !== null) return;
        this.gps.push({
          lat: p.coords.latitude,
          lon: p.coords.longitude,
          accuracy: p.coords.accuracy,
          t: p.timestamp,
          speed: p.coords.speed,
        });
        this.gpsState = this.gps.usable ? 'ok' : 'waiting';
      },
      (err) => {
        this.gpsState = err.code === err.PERMISSION_DENIED ? 'denied' : 'unavailable';
      },
      { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 },
    );
  }

  pause(): void {
    this.pausedAt ??= performance.now();
  }

  resume(): void {
    if (this.pausedAt !== null) this.pausedTotal += performance.now() - this.pausedAt;
    this.pausedAt = null;
  }

  stop(): void {
    if (this.watchId !== null) navigator.geolocation.clearWatch(this.watchId);
    this.watchId = null;
    this.gpsState = 'off';
  }

  snapshot(stepLength: number, lapMeters: number): RunSnapshot {
    const now = this.pausedAt ?? performance.now();
    const elapsedS = (now - this.startAt - this.pausedTotal) / 1000;
    const m = this.motion.snapshot();
    this.stepDistance = (this.motion.totalSteps - this.stepsAtStart) * stepLength;
    const useGps = this.gpsState === 'ok' && this.gps.distance > 0;
    const distanceM = useGps ? this.gps.distance : this.stepDistance;
    const speed = useGps ? this.gps.speed : m.walking ? (m.cadence / 60) * stepLength : 0;
    return {
      elapsedS,
      distanceM,
      speed,
      paceS: speed > 0.5 ? 1000 / speed : Infinity,
      cadence: m.cadence,
      laps: Math.floor(distanceM / lapMeters),
      source: useGps ? 'gps' : 'steps',
    };
  }
}
