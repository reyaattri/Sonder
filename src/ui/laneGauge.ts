import type { TrackReport } from '../track/trackSession';
import { evalCurve, imagePoint, type CameraModel } from '../track/world';

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
  centred: 'On line',
  drift: 'Drifting',
  strong: 'Drifting a lot',
  danger: 'At the edge',
  lost: 'Looking for the line',
} as const;

const AHEAD_M = 10;

/**
 * Moving mini-map of what EchoPath believes, in metres (like Project
 * Guideline's environment map): you at the bottom, the fitted line/lane
 * ahead, the line keypoints streaming toward you as you run, the look-ahead
 * target, and the way the guide tone is steering you.
 */
export function drawLaneGauge(canvas: HTMLCanvasElement, r: TrackReport | null, halfLaneM = 0.61, course: 'lanes' | 'line' | 'edge' = 'lanes'): void {
  const g = fit(canvas);
  if (!g) return;
  const cw = canvas.clientWidth, ch = canvas.clientHeight;
  const fg = css('--fg'), line = css('--line'), muted = css('--muted');
  const ok = css('--ok'), warn = css('--warn'), bad = css('--bad');
  const level = r?.level ?? 'lost';
  const colour = level === 'centred' ? ok : level === 'drift' ? warn : level === 'lost' ? muted : bad;

  const ox = cw / 2, oy = ch - 34;
  const ppm = Math.min(cw / 3.4, (oy - 70) / AHEAD_M); // pixels per metre
  const X = (x: number) => ox + x * ppm;
  const Y = (z: number) => oy - z * ppm;

  // Distance rings so motion and scale are readable.
  g.strokeStyle = line;
  g.lineWidth = 1;
  g.font = '600 11px system-ui, sans-serif';
  g.fillStyle = muted;
  for (const z of [2, 5, 10]) {
    g.setLineDash([3, 6]);
    g.beginPath();
    g.moveTo(X(-2.4), Y(z));
    g.lineTo(X(2.4), Y(z));
    g.stroke();
    g.setLineDash([]);
    g.fillText(`${z} m`, X(2.4) + 4, Y(z) + 4);
  }

  const w = r?.world;
  if (w) {
    // Keypoints (they stream toward you as you run).
    g.fillStyle = line;
    for (const p of w.points) {
      if (p.z < 0 || p.z > AHEAD_M) continue;
      g.fillRect(X(p.x) - 1.5, Y(p.z) - 1.5, 3, 3);
    }
    // Fitted line(s).
    const curve = (off: number, colourStroke: string, width: number, dash: number[] = []) => {
      g.strokeStyle = colourStroke;
      g.lineWidth = width;
      g.setLineDash(dash);
      g.beginPath();
      for (let z = 0; z <= Math.min(AHEAD_M, Math.max(4, w.centre.reach)); z += 0.5) {
        const x = evalCurve(w.centre, z) + off;
        if (z === 0) g.moveTo(X(x), Y(z));
        else g.lineTo(X(x), Y(z));
      }
      g.stroke();
      g.setLineDash([]);
    };
    if (course === 'lanes') {
      curve(-halfLaneM, fg, 6);
      curve(halfLaneM, fg, 6);
      curve(0, line, 1.5, [6, 6]);
    } else {
      curve(0, course === 'line' ? '#e3b100' : fg, 6);
    }
    // Look-ahead target and steering arrow.
    const t = w.control.target;
    g.strokeStyle = colour;
    g.lineWidth = 3;
    g.beginPath();
    g.arc(X(t.x), Y(t.z), 9, 0, 2 * Math.PI);
    g.stroke();
    g.beginPath();
    g.moveTo(ox, oy);
    g.lineTo(X(t.x), Y(t.z));
    g.setLineDash([4, 5]);
    g.stroke();
    g.setLineDash([]);
  } else if (r && !r.lost) {
    // Image-only fallback: lane lines straight ahead.
    g.strokeStyle = fg;
    g.lineWidth = 6;
    for (const x of [-halfLaneM, halfLaneM]) {
      const lx = x - (r.offset / 0.5) * halfLaneM;
      g.beginPath();
      g.moveTo(X(lx), Y(0));
      g.lineTo(X(lx), Y(AHEAD_M * 0.6));
      g.stroke();
    }
  }

  // You
  g.beginPath();
  g.arc(ox, oy, 15, 0, 2 * Math.PI);
  g.fillStyle = colour;
  g.fill();
  g.strokeStyle = fg;
  g.lineWidth = 3;
  g.stroke();
  // Guide direction chevron
  if (r && r.guide.magnitude > 0.02) {
    const dir = r.guide.steer >= 0 ? 1 : -1;
    g.fillStyle = colour;
    g.beginPath();
    g.moveTo(ox + dir * (26 + 18 * r.guide.magnitude), oy);
    g.lineTo(ox + dir * 20, oy - 12);
    g.lineTo(ox + dir * 20, oy + 12);
    g.closePath();
    g.fill();
  }

  // Status text
  g.textAlign = 'center';
  if (r?.stopped) {
    g.font = '900 44px system-ui, sans-serif';
    g.fillStyle = bad;
    g.fillText('STOP', ox, 50);
  } else {
    g.font = '800 22px system-ui, sans-serif';
    g.fillStyle = colour;
    const side = r && !r.lost && level !== 'centred' ? (r.guide.steer > 0 ? ': steer right' : ': steer left') : '';
    g.fillText(LABEL[level] + side, ox, 30);
    const extra = r?.bend ? `Bend ${r.bend} ahead` : r?.runnerAhead ? `Runner ahead ${r.runnerAhead.distance.toFixed(0)} m` : '';
    if (extra) {
      g.font = '800 17px system-ui, sans-serif';
      g.fillStyle = r?.runnerAhead && !r.bend ? bad : muted;
      g.fillText(extra, ox, 54);
    }
  }
  if (w) {
    g.font = '700 13px system-ui, sans-serif';
    g.fillStyle = muted;
    g.fillText(`${Math.abs(w.lateral).toFixed(2)} m ${w.lateral > 0 ? 'right' : 'left'} of ${course === 'lanes' ? 'lane centre' : 'the line'}`, ox, ch - 8);
  }
  g.textAlign = 'left';
}

/** Camera overlay: detected line keypoints, and the world fit projected back onto the image. */
export function drawLaneOverlay(canvas: HTMLCanvasElement, video: HTMLVideoElement | HTMLCanvasElement, r: TrackReport, viewCam?: CameraModel): void {
  const g = fit(canvas);
  if (!g) return;
  const cw = canvas.clientWidth, ch = canvas.clientHeight;
  const vw = 'videoWidth' in video ? video.videoWidth : video.width;
  const vh = 'videoHeight' in video ? video.videoHeight : video.height;
  const vr = (vw || 16) / (vh || 9);
  let w = cw, h = cw / vr;
  if (h > ch) {
    h = ch;
    w = ch * vr;
  }
  const ox = (cw - w) / 2, oy = (ch - h) / 2;
  // Keypoints (lane-canvas pixels -> display).
  const sx = w / r.lane.width, sy = h / r.lane.height;
  g.fillStyle = '#00e5ff';
  for (const p of [...r.lane.keypoints.left, ...r.lane.keypoints.right]) g.fillRect(ox + p.x * sx - 1.5, oy + p.y * sy - 1.5, 3, 3);
  // World fit drawn back into the image: proves the metric model lines up.
  const wd = r.world;
  if (wd) {
    const cam = viewCam ?? wd.cam;
    const ix = w / cam.width, iy = h / cam.height;
    const offs = r.lane.left && r.lane.right ? [-0.61, 0.61] : [0];
    g.strokeStyle = '#ff3df2';
    g.lineWidth = 3;
    for (const off of offs) {
      g.beginPath();
      let first = true;
      for (let z = 1; z <= Math.min(18, Math.max(4, wd.centre.reach)); z += 0.5) {
        const ip = imagePoint({ x: evalCurve(wd.centre, z) + off, z }, cam);
        if (!ip) continue;
        const X = ox + ip.u * ix, Y = oy + ip.v * iy;
        if (first) g.moveTo(X, Y);
        else g.lineTo(X, Y);
        first = false;
      }
      g.stroke();
    }
  }
  // People (real ones in the live view): box + distance; red if in your way.
  g.font = '700 12px system-ui, sans-serif';
  for (const p of r.people) {
    const ahead = r.runnerAhead?.id === p.id;
    g.strokeStyle = ahead ? '#ff3b30' : '#30d158';
    g.lineWidth = ahead ? 3 : 2;
    g.strokeRect(ox + p.box.x * w, oy + p.box.y * h, p.box.w * w, p.box.h * h);
    const label = `${p.label} ${p.distance.toFixed(1)} m`;
    g.fillStyle = 'rgba(0,0,0,0.7)';
    g.fillRect(ox + p.box.x * w, oy + p.box.y * h - 16, g.measureText(label).width + 8, 16);
    g.fillStyle = '#fff';
    g.fillText(label, ox + p.box.x * w + 4, oy + p.box.y * h - 4);
  }
}
