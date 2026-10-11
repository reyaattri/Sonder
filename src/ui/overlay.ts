import type { FrameReport } from '../app/session';
import { COLS, ROI_TOP, ROWS } from '../perception/freespace';
import { G_TOP, GCOLS, GROWS } from '../perception/ground';

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

  // Walkable path (looks like the ground under your feet): green cells.
  if (r.path && r.path.confidence > 0) {
    g.fillStyle = 'rgba(0, 230, 120, 0.28)';
    for (let row = 0; row < ROWS; row++)
      for (let c = 0; c < COLS; c++) {
        if (!r.path.path[row * COLS + c]) continue;
        const x = X(c / COLS), y = Y(ROI_TOP + (row / ROWS) * (1 - ROI_TOP));
        g.fillRect(x, y, w / COLS + 0.5, (h * (1 - ROI_TOP)) / ROWS + 0.5);
      }
  }
  // Leaf litter: orange cells, outlined so they read on top of the path tint.
  if (r.ground) {
    g.fillStyle = 'rgba(255, 140, 0, 0.45)';
    g.strokeStyle = 'rgba(255, 170, 40, 0.9)';
    g.lineWidth = 1;
    const cw = w / GCOLS, ch = (h * (1 - G_TOP)) / GROWS;
    for (let row = 0; row < GROWS; row++)
      for (let c = 0; c < GCOLS; c++) {
        if (!r.ground.leaves[row * GCOLS + c]) continue;
        const x = X(c / GCOLS), y = Y(G_TOP + (row / GROWS) * (1 - G_TOP));
        g.fillRect(x, y, cw, ch);
        g.strokeRect(x + 0.5, y + 0.5, cw - 1, ch - 1);
      }
  }
  // Looming pathway: per-sector excitation bars along the top.
  if (r.lgmd) {
    (['left', 'center', 'right'] as const).forEach((sec, i) => {
      const st = r.lgmd!.sectors[sec];
      const v = Math.max(0, Math.min(1, st.z / 8));
      g.fillStyle = r.lgmd!.looming === sec ? '#ff2d2d' : st.spike ? '#ffb020' : 'rgba(255,255,255,0.5)';
      g.fillRect(X(i / 3) + 4, Y(0) + 4, (w / 3 - 8) * v, 6);
    });
  }

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

  // Stats are shown as text under the view, never over the picture.
}

export function clearOverlay(canvas: HTMLCanvasElement): void {
  canvas.getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height);
}
