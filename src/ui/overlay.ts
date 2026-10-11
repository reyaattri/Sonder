import type { FrameReport } from '../app/session';

const COLORS = { person: '#ffd60a', vehicle: '#ff4d6d', static: '#4cc9f0' } as const;

/**
 * High-contrast debug overlay for sighted teammates and judges: corridor,
 * zones, tracked boxes with id/distance/time-to-contact, and live stats.
 * Purely visual and off by default; nothing here is needed to use the app.
 */
export function drawOverlay(canvas: HTMLCanvasElement, video: HTMLVideoElement, r: FrameReport, centerWidth: number, corridorWidth: number): void {
  const dpr = window.devicePixelRatio || 1;
  const cw = canvas.clientWidth, ch = canvas.clientHeight;
  if (canvas.width !== Math.round(cw * dpr) || canvas.height !== Math.round(ch * dpr)) {
    canvas.width = Math.round(cw * dpr);
    canvas.height = Math.round(ch * dpr);
  }
  const g = canvas.getContext('2d')!;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, cw, ch);

  // Video is drawn with object-fit: contain; map normalized coords into that rect.
  const vr = (video.videoWidth || 16) / (video.videoHeight || 9);
  let w = cw, h = cw / vr;
  if (h > ch) {
    h = ch;
    w = ch * vr;
  }
  const ox = (cw - w) / 2, oy = (ch - h) / 2;
  const X = (n: number) => ox + n * w;
  const Y = (n: number) => oy + n * h;

  // Corridor and zones
  g.fillStyle = 'rgba(0,0,0,0.35)';
  const lo = 0.5 - corridorWidth / 2, hi = 0.5 + corridorWidth / 2;
  g.fillRect(X(0), Y(0), X(lo) - X(0), h);
  g.fillRect(X(hi), Y(0), X(1) - X(hi), h);
  g.strokeStyle = 'rgba(255,255,255,0.8)';
  g.setLineDash([8, 6]);
  g.lineWidth = 2;
  for (const x of [0.5 - centerWidth / 2, 0.5 + centerWidth / 2]) {
    g.beginPath();
    g.moveTo(X(x), Y(0));
    g.lineTo(X(x), Y(1));
    g.stroke();
  }
  g.setLineDash([]);

  if (r.policy.blocked) {
    g.fillStyle = 'rgba(255,0,0,0.25)';
    g.fillRect(X(0.5 - centerWidth / 2), Y(0), centerWidth * w, h);
  }
  if (r.looming) {
    g.strokeStyle = '#ff0000';
    g.lineWidth = 6;
    g.strokeRect(X(0.25), Y(0.2), 0.5 * w, 0.6 * h);
  }

  const sounding = new Set(r.policy.sources.map((s) => s.trackId));
  g.font = '600 15px system-ui, sans-serif';
  for (const t of r.tracks) {
    if (!t.confirmed) continue;
    const c = COLORS[t.category];
    g.strokeStyle = c;
    g.lineWidth = sounding.has(t.id) ? 5 : 2;
    g.strokeRect(X(t.box.x), Y(t.box.y), t.box.w * w, t.box.h * h);
    const ttc = Number.isFinite(t.ttc) ? ` · ${t.ttc.toFixed(1)}s` : '';
    const text = `#${t.id} ${t.label} ${t.distance.toFixed(1)}m${ttc}`;
    const tw = g.measureText(text).width + 8;
    const ty = Math.max(oy, Y(t.box.y) - 22);
    g.fillStyle = '#000';
    g.fillRect(X(t.box.x), ty, tw, 22);
    g.fillStyle = c;
    g.fillText(text, X(t.box.x) + 4, ty + 16);
  }

  if (r.policy.guideSide) {
    g.fillStyle = '#00ff88';
    g.font = '700 48px system-ui, sans-serif';
    const arrow = r.policy.guideSide === 'left' ? '◀' : '▶';
    g.fillText(arrow, r.policy.guideSide === 'left' ? X(0.03) : X(0.97) - 48, Y(0.5));
  }

  const st = r.stats;
  const lines = [
    `${st.fps.toFixed(1)} FPS · infer ${fmt(st.inferenceP50)} ms`,
    `capture→sound p95 ${fmt(st.latencyP95)} ms (n=${st.latencySamples})`,
    `${st.model} @${st.inputWidth}px · ${st.backend} · ${st.where}`,
    `sources: ${r.policy.sources.map((s) => s.kind).join(', ') || 'none'}${r.quality !== 'ok' ? ' · ' + r.quality.toUpperCase() : ''}`,
  ];
  // Stats sit top-left, under the Settings/Stop buttons and clear of the pause label.
  g.font = '600 14px ui-monospace, monospace';
  const boxH = lines.length * 19 + 10;
  const sy = 76;
  g.fillStyle = 'rgba(0,0,0,0.8)';
  g.fillRect(6, sy, Math.min(cw - 12, 380), boxH);
  g.fillStyle = '#fff';
  lines.forEach((l, i) => g.fillText(l, 12, sy + 18 + i * 19));
}

const fmt = (n: number) => (Number.isFinite(n) ? n.toFixed(0) : '–');

export function clearOverlay(canvas: HTMLCanvasElement): void {
  canvas.getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height);
}
