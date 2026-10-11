import type { Zone } from '../core/types';
import { classInfo } from './classes';
import type { Track } from './tracker';

/**
 * While the wearer walks, a static obstacle ahead closes at walking speed:
 * tau = distance / speed. This is steadier than box growth alone for things
 * that don't move (benches, poles, chairs), and lets them get spoken
 * warnings like moving objects do (US-6.2 stretch).
 * Only center-zone obstacles count: things off to the side are passed, not hit.
 */
export function applyEgoMotion(tracks: Track[], walking: boolean, speed: number): void {
  if (!walking || speed < 0.3) return;
  for (const t of tracks) {
    if (t.category !== 'static' || t.zone !== 'center' || !Number.isFinite(t.distance)) continue;
    const tau = t.distance / speed;
    if (tau < t.ttc) {
      t.ttc = tau;
      t.approaching = tau < 10;
    }
  }
}

const SIDE: Record<Zone, string> = { left: 'left', center: 'ahead', right: 'right' };

function metres(d: number): string {
  if (d < 1) return 'under 1 metre';
  const r = d < 3 ? Math.round(d * 2) / 2 : Math.round(d);
  return `about ${r} metre${r === 1 ? '' : 's'}`;
}

/**
 * Spoken summary for "what's around me?" — nearest first, at most four.
 * Never claims the way is clear: silence/emptiness only means nothing was detected.
 */
export function describeScene(tracks: readonly Track[]): string {
  const seen = tracks.filter((t) => t.confirmed).sort((a, b) => a.distance - b.distance).slice(0, 4);
  if (seen.length === 0) return 'Nothing detected right now. That does not mean the way is clear.';
  return seen
    .map((t) => `${classInfo(t.label)?.spoken ?? t.label}, ${SIDE[t.zone]}, ${metres(t.distance)}${t.approaching && t.ttc < 4 ? ', approaching' : ''}.`)
    .join(' ');
}
