import type { TrackReport } from '../track/trackSession';

function css(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#888';
}

function fit(canvas: HTMLCanvasElement): CanvasRenderingContext2D | null {
  const dpr = window.devicePixelRatio || 1;
  const cw = canvas.clientWidth, ch = canvas.clientHeight;
  if (!cw || !ch) return null;
  if (canvas.width !== Math.round(cw * dpr) || canvas.height !== Math.round(ch * dpr)) {
    canvas.width = Math.round(cw * dpr);
    canvas.height = Math.round(ch * dpr);
  }
  const g = canvas.getContext('2d')!;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, cw, ch);
  return g;
}

const LABEL = {
  centred: 'Centred',
  drift: 'Drifting',
  strong: 'Drifting a lot',
  danger: 'On the line',
  lost: 'Looking for lane lines',
} as const;

/**
 * Top-down lane view: your lane's two lines, your position (solid dot),
 * where you'll be in a moment (ring), and your heading. Green when centred,
 * amber/red as you drift. Visual only, for coaches and demo audiences.
 */
export function drawLaneGauge(canvas: HTMLCanvasElement, r: TrackReport | null): void {
  const g = fit(canvas);
  if (!g) return;
  const cw = canvas.clientWidth, ch = canvas.clientHeight;
  const fg = css('--fg'), line = css('--line'), muted = css('--muted');
  const ok = css('--ok'), warn = css('--warn'), bad = css('--bad');
  const laneW = Math.min(cw * 0.55, 300);
  const cx = cw / 2, x0 = cx - laneW / 2, x1 = cx + laneW / 2;
  const top = 16, bottom = ch - 16;

  // Neighbouring lanes (faint) and your lane lines
  g.lineWidth = 2;
  g.strokeStyle = line;
  g.setLineDash([6, 10]);
  for (const x of [x0 - laneW, x1 + laneW]) {
    if (x < 0 || x > cw) continue;
    g.beginPath();
    g.moveTo(x, top);
    g.lineTo(x, bottom);
    g.stroke();
  }
  const lost = !r || r.lost;
  g.setLineDash(lost ? [10, 10] : []);
  g.lineWidth = 8;
  g.strokeStyle = lost ? line : fg;
  for (const x of [x0, x1]) {
    g.beginPath();
    g.moveTo(x, top);
    g.lineTo(x, bottom);
    g.stroke();
  }
  g.setLineDash([]);

  // Free zone (deadband) hint
  g.fillStyle = ok + '22';
  g.fillRect(cx - laneW * 0.12, top, laneW * 0.24, bottom - top);

  const level = r?.level ?? 'lost';
  const colour = level === 'centred' ? ok : level === 'drift' ? warn : level === 'lost' ? muted : bad;
  const y = ch * 0.68;

  if (r && !r.lost) {
    const px = (o: number) => cx + Math.max(-0.7, Math.min(0.7, o)) * laneW;
    // Predicted position
    g.beginPath();
    g.arc(px(r.predicted), y - 46, 12, 0, 2 * Math.PI);
    g.strokeStyle = colour;
    g.lineWidth = 3;
    g.stroke();
    // Heading arrow
    const x = px(r.offset);
    const ang = r.heading;
    g.beginPath();
    g.moveTo(x, y);
    g.lineTo(x + Math.sin(ang) * 70, y - Math.cos(ang) * 70);
    g.strokeStyle = colour;
    g.lineWidth = 4;
    g.stroke();
    // You
    g.beginPath();
    g.arc(x, y, 18, 0, 2 * Math.PI);
    g.fillStyle = colour;
    g.fill();
    g.strokeStyle = fg;
    g.lineWidth = 3;
    g.stroke();
  }

  // Status text
  g.font = '800 22px system-ui, sans-serif';
  g.textAlign = 'center';
  g.fillStyle = colour;
  const side = r && !r.lost && level !== 'centred' ? (r.predicted > 0 ? ' right' : ' left') : '';
  g.fillText(LABEL[level] + side, cx, top + 30);
  if (r?.runnerAhead) {
    g.font = '800 18px system-ui, sans-serif';
    g.fillStyle = bad;
    g.fillText(`Runner ahead ${r.runnerAhead.distance.toFixed(0)} m`, cx, top + 58);
  }
}

/** Camera thumbnail overlay: the detected lane lines over the video. */
export function drawLaneOverlay(canvas: HTMLCanvasElement, video: HTMLVideoElement, r: TrackReport): void {
  const g = fit(canvas);
  if (!g) return;
  const cw = canvas.clientWidth, ch = canvas.clientHeight;
  const vr = (video.videoWidth || 16) / (video.videoHeight || 9);
  let w = cw, h = cw / vr;
  if (h > ch) {
    h = ch;
    w = ch * vr;
  }
  const ox = (cw - w) / 2, oy = (ch - h) / 2;
  const sx = w / r.lane.width, sy = h / r.lane.height;
  g.fillStyle = 'rgba(0,0,0,0.35)';
  g.fillRect(ox, oy, w, h * 0.45);
  g.lineWidth = 3;
  for (const [l, c] of [
    [r.lane.left, '#00e5ff'],
    [r.lane.right, '#ff3df2'],
  ] as const) {
    if (!l) continue;
    const y0 = r.lane.height * 0.45, y1 = r.lane.height - 1;
    g.strokeStyle = c;
    g.beginPath();
    g.moveTo(ox + (l.a * y0 + l.b) * sx, oy + y0 * sy);
    g.lineTo(ox + (l.a * y1 + l.b) * sx, oy + y1 * sy);
    g.stroke();
  }
  g.font = '700 12px ui-monospace, monospace';
  g.fillStyle = '#fff';
  g.fillText(`${r.fps.toFixed(0)} fps · lane ${r.laneMs.toFixed(1)} ms · off ${r.offset.toFixed(2)}`, ox + 6, oy + 16);
}
