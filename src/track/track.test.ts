import { describe, expect, it } from 'vitest';
import { driftLevel, hapticPattern, LaneFeedback } from './feedback';
import { AnnounceSchedule, formatPace, GpsDistance, haversine, parseHeartRate, runSummary, type RunSnapshot } from './run';

describe('lane feedback', () => {
  const cfg = { deadband: 0.12, cueSide: 'line' as const };

  it('silent while centred; levels rise with drift', () => {
    expect(driftLevel(0.05, 0.12)).toBe('centred');
    expect(driftLevel(0.2, 0.12)).toBe('drift');
    expect(driftLevel(0.3, 0.12)).toBe('strong');
    expect(driftLevel(0.45, 0.12)).toBe('danger');
    const f = new LaneFeedback();
    expect(f.update(0.03, false, 0, cfg).ping).toBe(false);
  });

  it('drifting right pings from the right (the line) and repeats faster when stronger', () => {
    const f = new LaneFeedback();
    const e = f.update(0.2, false, 0, cfg);
    expect(e).toMatchObject({ ping: true, pan: 1, level: 'drift' });
    expect(f.update(0.2, false, 300, cfg).ping).toBe(false); // drift: every 450 ms
    expect(f.update(0.2, false, 460, cfg).ping).toBe(true);
    expect(f.update(0.33, false, 500, cfg).ping).toBe(true); // escalation pings immediately
    expect(f.update(0.33, false, 730, cfg).ping).toBe(true); // strong: every 220 ms
  });

  it("'steer' mode cues the side to move toward", () => {
    const f = new LaneFeedback();
    expect(f.update(0.2, false, 0, { ...cfg, cueSide: 'steer' }).pan).toBe(-1);
  });

  it('confirms recovery once after returning to centre', () => {
    const f = new LaneFeedback();
    f.update(-0.3, false, 0, cfg);
    f.update(-0.3, false, 900, cfg); // a drift that lasted
    expect(f.update(0, false, 1000, cfg).recovered).toBe(true);
    expect(f.update(0, false, 1100, cfg).recovered).toBe(false);
    f.update(0.2, false, 1200, cfg); // tiny wobble
    expect(f.update(0, false, 1300, cfg).recovered).toBe(false);
  });

  it('haptics: left = one pulse, right = two, longer when stronger', () => {
    expect(hapticPattern(-1, 'drift')).toEqual([25]);
    expect(hapticPattern(1, 'drift')).toEqual([25, 70, 25]);
    expect(hapticPattern(1, 'danger')[0]).toBeGreaterThan(hapticPattern(1, 'drift')[0]);
  });
});

describe('run metrics', () => {
  it('haversine: 0.001 deg latitude is ~111 m', () => {
    expect(haversine({ lat: 0, lon: 0 }, { lat: 0.001, lon: 0 })).toBeCloseTo(111.2, 0);
  });

  it('GPS distance ignores inaccurate fixes and impossible jumps', () => {
    const g = new GpsDistance();
    const fix = (lat: number, t: number, accuracy = 5) => ({ lat, lon: 0, accuracy, t, speed: null });
    g.push(fix(0, 0));
    g.push(fix(0.00004, 1000)); // ~4.4 m in 1 s
    g.push(fix(0.0009, 2000, 60)); // inaccurate: ignored
    g.push(fix(0.01, 3000)); // ~1 km in 1 s: jump, ignored
    g.push(fix(0.00008, 2000 + 1000)); // another ~4.4 m
    expect(g.distance).toBeGreaterThan(8);
    expect(g.distance).toBeLessThan(10);
    expect(g.speed).toBeGreaterThan(3);
  });

  it('parses 8- and 16-bit heart-rate measurements', () => {
    expect(parseHeartRate(new DataView(new Uint8Array([0, 152]).buffer))).toBe(152);
    expect(parseHeartRate(new DataView(new Uint8Array([1, 0x2c, 0x01]).buffer))).toBe(300);
  });

  it('spoken summary and pace formatting', () => {
    const r: RunSnapshot = { elapsedS: 312, distanceM: 1000, speed: 3.2, paceS: 312, cadence: 171.6, heartRate: 151, laps: 2, source: 'gps' };
    expect(runSummary(r, 'Lap 2.')).toBe(
      'Lap 2. 1.00 kilometres in 5 minutes 12 seconds. Pace 5 12 per kilometre. Cadence 172. Heart rate 151.',
    );
    expect(formatPace(305)).toBe('5:05');
    expect(formatPace(Infinity)).toBe('–');
  });

  it('announces once per lap', () => {
    const s = new AnnounceSchedule();
    const r = (laps: number): RunSnapshot => ({ elapsedS: 60, distanceM: laps * 400, speed: 3, paceS: 333, cadence: 0, heartRate: null, laps, source: 'gps' });
    expect(s.due(r(0), 'lap', 2)).toBeNull();
    expect(s.due(r(1), 'lap', 2)).toBe('Lap 1.');
    expect(s.due(r(1), 'lap', 2)).toBeNull();
  });
});
