import type { FrameReport } from '../app/session';

const RANGE_M = 6;
const RINGS = [1, 2, 3, 5];
/** Rings are drawn over +/-60 deg; everything the camera sees is inside +/-35 deg. */
const VIEW = (60 * Math.PI) / 180;

function css(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#888';
}

/**
 * Top-down "what EchoPath hears" view: you at the bottom, the camera's field
 * of view as a wedge, distance rings, and each tracked object as a dot at its
 * direction and estimated distance. Sounding objects pulse; the blocked path
 * glows red and the guide arrow points to the freer side. Purely visual,
 * for sighted helpers and demo audiences.
 */
export function drawRadar(canvas: HTMLCanvasElement, r: FrameReport | null, fovDeg: number, now: number): void {
  const dpr = window.devicePixelRatio || 1;
  const cw = canvas.clientWidth, ch = canvas.clientHeight;
  if (!cw || !ch) return;
  if (canvas.width !== Math.round(cw * dpr) || canvas.height !== Math.round(ch * dpr)) {
    canvas.width = Math.round(cw * dpr);
    canvas.height = Math.round(ch * dpr);
  }
  const g = canvas.getContext('2d')!;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, cw, ch);

  const fg = css('--fg'), muted = css('--muted'), line = css('--line');
  const colors: Record<string, string> = {
    person: css('--c-person'),
    vehicle: css('--c-vehicle'),
    static: css('--c-static'),
  };
  const danger = css('--c-danger'), guide = css('--c-guide');

  const ox = cw / 2, oy = ch - 28;
  const half = ((fovDeg / 2) * Math.PI) / 180;
  // Fill the height on tall (portrait) screens: only the camera's wedge must
  // fit across; outer rings may run off the sides.
  const R = Math.max(40, Math.min((cw / 2 - 14) / Math.sin(half + 0.08), oy - 24));
  const px = R / RANGE_M;

  // Field-of-view wedge
  g.beginPath();
  g.moveTo(ox, oy);
  g.arc(ox, oy, R, -Math.PI / 2 - half, -Math.PI / 2 + half);
  g.closePath();
  g.fillStyle = line + '22';
  g.fill();
  g.strokeStyle = line;
  g.lineWidth = 1.5;
  g.stroke();

  // Blocked path: red wedge straight ahead
  if (r?.policy.blocked) {
    const pulse = 0.35 + 0.25 * Math.sin(now / 90);
    g.beginPath();
    g.moveTo(ox, oy);
    g.arc(ox, oy, R * 0.55, -Math.PI / 2 - 0.22, -Math.PI / 2 + 0.22);
    g.closePath();
    g.globalAlpha = pulse;
    g.fillStyle = danger;
    g.fill();
    g.globalAlpha = 1;
  }

  // Distance rings
  g.font = '600 12px system-ui, sans-serif';
  g.textAlign = 'left';
  for (const m of RINGS) {
    g.beginPath();
    g.arc(ox, oy, m * px, -Math.PI / 2 - VIEW, -Math.PI / 2 + VIEW);
    g.strokeStyle = line;
    g.lineWidth = 1;
    g.setLineDash([3, 5]);
    g.stroke();
    g.setLineDash([]);
    g.fillStyle = muted;
    g.fillText(`${m} m`, ox + 4, oy - m * px - 3);
  }

  // You
  g.beginPath();
  g.arc(ox, oy, 9, 0, 2 * Math.PI);
  g.fillStyle = fg;
  g.fill();
  g.textAlign = 'center';
  g.fillStyle = muted;
  g.fillText('you', ox, oy + 22);

  if (!r) return;

  // Guide arrow toward the freer side
  if (r.policy.guideSide) {
    const dir = r.policy.guideSide === 'left' ? -1 : 1;
    const ax = ox + dir * Math.min(R * 0.75, cw / 2 - 30), ay = oy - R * 0.45;
    g.fillStyle = guide;
    g.beginPath();
    g.moveTo(ax + dir * 22, ay);
    g.lineTo(ax - dir * 6, ay - 18);
    g.lineTo(ax - dir * 6, ay + 18);
    g.closePath();
    g.fill();
    g.font = '700 14px system-ui, sans-serif';
    g.fillText(`step ${r.policy.guideSide}`, ax, ay + 36);
  }

  const sounding = new Set(r.policy.sources.map((s) => s.trackId));
  g.font = '700 13px system-ui, sans-serif';
  for (const t of r.tracks) {
    if (!t.confirmed) continue;
    const d = Math.min(RANGE_M, Math.max(0.3, t.distance));
    const x = ox + Math.sin(t.azimuth) * d * px;
    const y = oy - Math.cos(t.azimuth) * d * px;
    const c = colors[t.category] ?? fg;
    if (sounding.has(t.id)) {
      const k = (now % 700) / 700;
      g.beginPath();
      g.arc(x, y, 10 + 16 * k, 0, 2 * Math.PI);
      g.strokeStyle = c;
      g.globalAlpha = 1 - k;
      g.lineWidth = 3;
      g.stroke();
      g.globalAlpha = 1;
    }
    g.beginPath();
    g.arc(x, y, 10, 0, 2 * Math.PI);
    g.fillStyle = c;
    g.fill();
    g.strokeStyle = fg;
    g.lineWidth = 2;
    g.stroke();
    const label = `${t.label} ${t.distance.toFixed(1)}m${Number.isFinite(t.ttc) && t.ttc < 6 ? ` · ${t.ttc.toFixed(1)}s` : ''}`;
    g.fillStyle = fg;
    g.fillText(label, x, y - 16);
  }
}
