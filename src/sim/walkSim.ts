import type { FrameSource } from '../camera/source';
import type { MotionSensor } from '../sensors/motion';
import { groundPoint, type CameraModel } from '../track/world';
import { drawPerson, LOOKS, type Look } from './simulator';

/** Simulated chest camera: portrait phone, 65 deg long-side field of view. */
const W = 270, H = 360;
const FPS = 24;
/** Park path half-width (m). The walker's body radius (m). */
const PATH_HALF = 1.2;
const BODY_R = 0.25;
const SEGMENT_M = 30;

export type ObstacleKind = 'pole' | 'bollard' | 'bin' | 'cone' | 'barrel' | 'sign' | 'plate' | 'bench' | 'rock' | 'leaves' | 'tree';

export interface Obstacle {
  id: number;
  kind: ObstacleKind;
  /** Along the path (m) and across it (m, + right). */
  x: number;
  y: number;
  /** Visual width and top height (m); `bottom` > 0 for things that overhang (a sign plate). */
  w: number;
  h: number;
  bottom: number;
  /** Collision radius (0 = you can walk over it, like leaves). */
  r: number;
  /** Length along the path for long things (a bench); 0 = round. */
  len: number;
}

/** Real-world sizes, roughly: what a white-cane user meets on a city park path. */
const SPEC: Record<ObstacleKind, { w: number; h: number; r: number; bottom?: number; len?: number; name: string }> = {
  pole: { w: 0.14, h: 3.6, r: 0.1, name: 'lamp post' },
  bollard: { w: 0.22, h: 0.95, r: 0.13, name: 'bollard' },
  bin: { w: 0.55, h: 1.05, r: 0.3, name: 'bin' },
  cone: { w: 0.36, h: 0.7, r: 0.18, name: 'traffic cone' },
  barrel: { w: 0.58, h: 1.05, r: 0.3, name: 'traffic barrel' },
  sign: { w: 0.08, h: 2.1, r: 0.06, name: 'sign post' },
  plate: { w: 0.7, h: 2.1, r: 0.32, bottom: 1.5, name: 'sign at head height' },
  // Parallel to the path, at its edge, as park benches are.
  bench: { w: 0.5, h: 0.85, r: 0.25, len: 1.6, name: 'bench' },
  rock: { w: 0.32, h: 0.13, r: 0.15, name: 'rock' },
  leaves: { w: 1.1, h: 0, r: 0, name: 'leaves' },
  tree: { w: 0.35, h: 4.5, r: 0.2, name: 'tree' },
};

export const obstacleName = (k: ObstacleKind): string => SPEC[k].name;

interface Pedestrian {
  look: Look;
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** Cruising speed along vx. */
  cruise: number;
  role: 'oncoming' | 'ahead' | 'crossing';
  /** For drawPerson's stride animation. */
  s: { speed: number; distance: number };
  /** Keeps the same lane offset they want to walk at. */
  lane: number;
}

/** What EchoPath is telling the walker (set by the app each frame). */
export interface WalkGuidance {
  blocked: boolean;
  side: 'left' | 'right' | null;
  noWay: boolean;
  /** Virtual-cane distance (m) when its tone is sounding. */
  caneM?: number | null;
  /** "Person ahead, walking your way: pass on the ..." */
  pass?: 'left' | 'right' | null;
}

export interface WalkScore {
  metres: number;
  /** Obstacles and people that were in the walker's way. */
  inWay: number;
  /** ...of which got past without touching. */
  cleared: number;
  bumps: number;
  headBumps: number;
  /** Times a "sighted helper" had to step in after a long stop. */
  assists: number;
  stops: number;
}

/** Deterministic random numbers per segment, so a course is repeatable. */
function rng(seed: number): () => number {
  let s = (seed * 2654435761) % 2147483647 || 1;
  return () => (s = (s * 16807) % 2147483647) / 2147483647;
}

/**
 * Real-time WALK simulator: a park path with real-world street furniture
 * (lamp posts, bollards, bins, cones, Project Guideline-style traffic
 * barrels, benches, sign plates at head height, rocks, fallen leaves) and
 * people (oncoming walkers who sidestep you as real people do, slower
 * walkers ahead, people crossing). Rendered from a chest camera into a
 * canvas whose stream feeds EchoPath's REAL walk pipeline: object detector,
 * Depth Anything virtual cane, path model, looming, cue policy, speech.
 *
 * Project Guideline's own Unreal simulator does not support obstacles yet
 * (their README); this one is built for exactly that.
 *
 * The autopilot is a blind walker: it walks straight with a little wander,
 * keeps to the path the way a cane user does (shorelining off the grass
 * edge), and otherwise acts ONLY on what EchoPath says: stop, or step left /
 * right. Bumps, head bumps and helper assists are counted.
 */
export class WalkSimulator {
  readonly canvas = Object.assign(document.createElement('canvas'), { width: W, height: H });
  readonly video = document.createElement('video');
  autopilot = true;
  /** Frozen until the walk session is actually running. */
  frozen = true;
  input = { left: false, right: false };
  guidance: WalkGuidance = { blocked: false, side: null, noWay: false };
  walker = { x: 0, y: 0, theta: 0, speed: 0, distance: 0, cruise: 1.3 };
  readonly score: WalkScore = { metres: 0, inWay: 0, cleared: 0, bumps: 0, headBumps: 0, assists: 0, stops: 0 };
  /** Most recent collision, for the screen ("Bumped: bin"). */
  lastBump: { what: string; at: number } | null = null;
  /** Every contact, for reviewing what EchoPath missed. */
  readonly bumpLog: { what: string; x: number; side: number }[] = [];
  pitch = 0.35;
  mountHeight = 1.3;
  fovDeg = 65;
  people: Pedestrian[] = [];
  private segments = new Map<number, Obstacle[]>();
  private ctx = this.canvas.getContext('2d')!;
  private img = this.ctx.createImageData(W, H);
  private timer: number | undefined;
  private lastT = 0;
  private wander = 0;
  private heard: { t: number; g: WalkGuidance }[] = [];
  private stream: MediaStream | null = null;
  private stepPhase = 0;
  private stoppedFor = 0;
  private wasStopped = false;
  private assist: { side: number; until: number } | null = null;
  /** After touching something: step away from it, as you do when your cane or body meets it. */
  private reflex: { side: number; until: number } | null = null;
  private pause = 0;
  private bumped = new Map<number, number>();
  private watched = new Map<number, boolean>();
  private nextId = 1;
  private rand = rng(99);

  constructor(private readonly motion: MotionSensor | null) {
    for (let i = 0; i < 3; i++) this.people.push(this.spawn((['oncoming', 'ahead', 'crossing'] as const)[i]));
  }

  source(): FrameSource {
    const sim = this;
    return {
      kind: 'camera',
      facing: 'environment',
      video: this.video,
      onLost: null,
      async start() {
        sim.start();
        sim.stream = sim.canvas.captureStream(FPS);
        sim.video.srcObject = sim.stream;
        sim.video.muted = true;
        sim.video.playsInline = true;
        await sim.video.play();
      },
      stop() {
        sim.stop();
      },
    };
  }

  start(): void {
    if (this.timer !== undefined) return;
    this.lastT = performance.now();
    this.timer = window.setInterval(() => this.tick(), 1000 / FPS);
    this.tick();
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.video.srcObject = null;
  }

  camera(): CameraModel {
    return { width: W, height: H, fovDeg: this.fovDeg, pitch: this.pitch, mountHeight: this.mountHeight };
  }

  /** All obstacles within [from, to] metres along the path. */
  obstacles(from: number, to: number): Obstacle[] {
    const out: Obstacle[] = [];
    for (let k = Math.floor(from / SEGMENT_M); k <= Math.floor(to / SEGMENT_M); k++)
      for (const o of this.segment(k)) if (o.x >= from && o.x <= to) out.push(o);
    return out;
  }

  /** The nearest thing in the walker's way (ground truth), for the screen. */
  aheadTruth(): { what: string; distance: number; side: number } | null {
    const w = this.walker;
    let best: { what: string; distance: number; side: number } | null = null;
    const consider = (what: string, x: number, y: number, r: number) => {
      const d = x - w.x;
      if (d < 0 || d > 8 || Math.abs(y - w.y) > r + BODY_R + 0.1) return;
      if (!best || d < best.distance) best = { what, distance: d, side: y - w.y };
    };
    for (const o of this.obstacles(w.x, w.x + 8)) if (o.r > 0 || o.kind === 'leaves') consider(SPEC[o.kind].name, o.x, o.y, Math.max(o.r, o.w / 2));
    for (const p of this.people) consider('person', p.x, p.y, BODY_R);
    return best;
  }

  private segment(k: number): Obstacle[] {
    let seg = this.segments.get(k);
    if (seg) return seg;
    seg = [];
    const r = rng(k + 7);
    const base = k * SEGMENT_M;
    const add = (kind: ObstacleKind, x: number, y: number) => {
      const s = SPEC[kind];
      seg!.push({ id: this.nextId++, kind, x, y, w: s.w, h: s.h, r: s.r, bottom: s.bottom ?? 0, len: s.len ?? 0 });
    };
    if (k >= 0) {
      // Two things on the path per 30 m, each leaving room to get past.
      const kinds: ObstacleKind[] = ['pole', 'pole', 'bollard', 'bin', 'bin', 'cone', 'barrel', 'sign', 'sign', 'rock', 'rock'];
      for (const at of [8 + r() * 5, 20 + r() * 6]) {
        const kind = kinds[Math.floor(r() * kinds.length)];
        const y = (r() - 0.5) * 1.3;
        if (kind === 'sign') {
          // Classic head-height hazard: post at the path edge, plate over the path.
          const edge = y < 0 ? -1.1 : 1.1;
          add('sign', base + at, edge);
          add('plate', base + at, edge - Math.sign(edge) * 0.4);
        } else add(kind, base + at, y);
      }
      if (r() < 0.45) add('bench', base + 14 + r() * 8, r() < 0.5 ? -1.25 : 1.25);
      if (r() < 0.7) add('leaves', base + 3 + r() * 24, (r() - 0.5) * 1.4);
    }
    for (let x = 2; x < SEGMENT_M; x += 7 + r() * 4) {
      add('tree', base + x, -(2.6 + r() * 1.6));
      add('tree', base + x + 3, 2.6 + r() * 1.6);
    }
    this.segments.set(k, seg);
    for (const old of this.segments.keys()) if (old < k - 3) this.segments.delete(old);
    return seg;
  }

  private spawn(role: Pedestrian['role']): Pedestrian {
    const w = this.walker, r = this.rand;
    const look = LOOKS[Math.floor(r() * LOOKS.length)];
    const lane = (r() - 0.5) * 1.2;
    if (role === 'oncoming') {
      const cruise = 1.1 + r() * 0.5;
      return { look, role, lane, x: w.x + 25 + r() * 15, y: lane, vx: -cruise, vy: 0, cruise, s: { speed: cruise, distance: 0 } };
    }
    if (role === 'ahead') {
      const cruise = 0.7 + r() * 0.3;
      return { look, role, lane, x: w.x + 10 + r() * 10, y: lane, vx: cruise, vy: 0, cruise, s: { speed: cruise, distance: 0 } };
    }
    const dir = r() < 0.5 ? 1 : -1;
    return { look, role, lane: 0, x: w.x + 9 + r() * 8, y: -dir * 4.5, vx: 0, vy: dir * 1.2, cruise: 1.2, s: { speed: 1.2, distance: 0 } };
  }

  private tick(): void {
    const now = performance.now();
    let dt = Math.min(0.05, (now - this.lastT) / 1000);
    this.lastT = now;
    if (dt <= 0) return;
    if (this.frozen) dt = 0;
    const w = this.walker;

    // --- The blind walker -------------------------------------------------
    this.heard.push({ t: now, g: this.guidance });
    while (this.heard.length > 1 && now - this.heard[0].t > 400) this.heard.shift(); // ~0.4 s to react
    const g = this.heard[0].g;
    let vx = w.cruise, vy = 0;
    this.wander += (-this.wander * 0.5 + (Math.random() - 0.5) * 1.6) * dt;
    if (this.autopilot) {
      vy = this.wander * 0.25;
      // Shorelining: the cane finds the grass edge and they step back in.
      if (Math.abs(w.y) > PATH_HALF - 0.3) vy -= Math.sign(w.y) * 0.45;
      // The cane tone speeding up: slow down as it gets closer.
      if (g.caneM != null) vx *= Math.max(0.35, Math.min(1, (g.caneM - 0.5) / 1.6));
      if (this.reflex && now < this.reflex.until) {
        vx = 0.35;
        vy = this.reflex.side * 0.7;
      } else if (this.assist && now < this.assist.until) {
        vx = 0.4;
        vy = this.assist.side * 0.7;
      } else if (g.blocked && g.side && !g.noWay) {
        vx = 0.45; // slow down and step around
        vy = g.side === 'left' ? -0.7 : 0.7;
      } else if (g.blocked) {
        vx = 0;
        vy = 0;
      } else if (g.pass) {
        vy += g.pass === 'left' ? -0.35 : 0.35; // ease out to pass
      }
    }
    vy += (this.input.right ? 0.8 : 0) - (this.input.left ? 0.8 : 0);
    if (this.pause > 0) {
      this.pause -= dt;
      vx = 0;
      vy = 0;
    }
    const stopped = vx < 0.05 && dt > 0;
    if (stopped && !this.wasStopped) this.score.stops++;
    this.wasStopped = stopped;
    this.stoppedFor = stopped ? this.stoppedFor + dt : 0;
    if (this.stoppedFor > 5 && this.autopilot) {
      // Stuck: a passer-by helps them past, to the side with more room.
      const near = this.obstacles(w.x, w.x + 3).filter((o) => o.r > 0)[0];
      this.assist = { side: near ? (near.y > w.y ? -1 : 1) : w.y > 0 ? -1 : 1, until: now + 1800 };
      this.score.assists++;
      this.stoppedFor = 0;
    }
    if (dt > 0) {
      w.x += vx * dt;
      w.y = Math.max(-PATH_HALF - 0.6, Math.min(PATH_HALF + 0.6, w.y + vy * dt));
      const want = Math.atan2(vy, Math.max(0.3, vx)) * 0.6; // chest turns part of the way
      const turn = (want - w.theta) * Math.min(1, dt * 4);
      w.theta += turn;
      w.speed = Math.hypot(vx, vy);
      w.distance += w.speed * dt;
      this.score.metres = w.x;
      this.collide(now);
      this.movePeople(dt);
    }

    // --- Sensors: walking bounce, tilt, turn rate -------------------------
    const cadence = w.speed > 0.1 ? 1.8 : 0;
    this.stepPhase += 2 * Math.PI * cadence * dt;
    const p = this.pitch + 0.01 * Math.sin(this.stepPhase);
    if (this.motion) {
      const acc = 9.81 + (w.speed > 0.1 ? 2.5 * Math.sin(this.stepPhase) : 0);
      const up = { x: 0, y: Math.cos(p), z: Math.sin(p) };
      const turnRate = dt > 0 ? ((w.theta - (this.lastTheta ?? w.theta)) / dt) * (180 / Math.PI) : 0;
      this.lastTheta = w.theta;
      this.motion.ingest({ x: up.x * acc, y: up.y * acc, z: up.z * acc }, { alpha: -turnRate * up.z, beta: 0, gamma: -turnRate * up.y }, now);
    }
    this.render({ ...this.camera(), pitch: p });
  }

  private lastTheta: number | undefined;

  /** A box from world corners, with only the faces you can see. */
  private box(
    x0: number, x1: number, y0: number, y1: number, bottom: number, top: number,
    col: [number, number, number], cam: CameraModel, f: number,
    toCam: (x: number, y: number) => { xr: number; z: number },
  ): void {
    const g = this.ctx, w = this.walker;
    const P = (x: number, y: number, up: number) => {
      const c = toCam(x, y);
      return project(c.xr, up, Math.max(0.2, c.z), cam, f);
    };
    const face = (pts: [number, number][], up0: number, up1: number, k: number) => {
      const ps = [P(pts[0][0], pts[0][1], up0), P(pts[1][0], pts[1][1], up0), P(pts[1][0], pts[1][1], up1), P(pts[0][0], pts[0][1], up1)];
      if (ps.some((p) => !p)) return;
      g.fillStyle = `rgb(${col[0] * k},${col[1] * k},${col[2] * k})`;
      g.beginPath();
      ps.forEach((p, i) => (i ? g.lineTo(p!.u, p!.v) : g.moveTo(p!.u, p!.v)));
      g.closePath();
      g.fill();
    };
    if (w.y < y0) face([[x0, y0], [x1, y0]], bottom, top, 0.7);
    if (w.y > y1) face([[x0, y1], [x1, y1]], bottom, top, 0.7);
    if (w.x < x0) face([[x0, y0], [x0, y1]], bottom, top, 0.85);
    // Top
    const t = [P(x0, y0, top), P(x1, y0, top), P(x1, y1, top), P(x0, y1, top)];
    if (t.every(Boolean)) {
      g.fillStyle = `rgb(${Math.min(255, col[0] * 1.1)},${Math.min(255, col[1] * 1.1)},${Math.min(255, col[2] * 1.1)})`;
      g.beginPath();
      t.forEach((p, i) => (i ? g.lineTo(p!.u, p!.v) : g.moveTo(p!.u, p!.v)));
      g.closePath();
      g.fill();
    }
  }

  private drawBench(o: Obstacle, cam: CameraModel, f: number, toCam: (x: number, y: number) => { xr: number; z: number }): void {
    const x0 = o.x - o.len / 2, x1 = o.x + o.len / 2, y0 = o.y - o.w / 2, y1 = o.y + o.w / 2;
    const out = Math.sign(o.y); // backrest on the grass side
    const brown: [number, number, number] = [122, 84, 50], iron: [number, number, number] = [45, 45, 48];
    this.box(x0, x0 + 0.06, y0, y1, 0, 0.42, iron, cam, f, toCam);
    this.box(x1 - 0.06, x1, y0, y1, 0, 0.42, iron, cam, f, toCam);
    this.box(x0, x1, y0, y1, 0.42, 0.48, brown, cam, f, toCam);
    const by = out > 0 ? y1 - 0.06 : y0;
    this.box(x0, x1, by, by + 0.06, 0.52, o.h, brown, cam, f, toCam);
  }

  private collide(now: number): void {
    const w = this.walker;
    const things: { id: number; what: string; x: number; y: number; r: number; hx: number; head: boolean }[] = [];
    for (const o of this.obstacles(w.x - 2, w.x + 6))
      if (o.r > 0) things.push({ id: o.id, what: SPEC[o.kind].name, x: o.x, y: o.y, r: o.r, hx: o.len / 2, head: o.bottom > 1 });
    this.people.forEach((p, i) => things.push({ id: -1 - i, what: 'person', x: p.x, y: p.y, r: 0.22, hx: 0, head: false }));
    for (const t of things) {
      const dx = t.x - w.x, dy = t.y - w.y;
      // Scoring: was it in the way when 4 m ahead?
      if (t.id > 0 && dx < 4 && dx > 3 && !this.watched.has(t.id)) {
        const inWay = Math.abs(dy) < t.r + BODY_R + 0.05;
        this.watched.set(t.id, inWay);
        if (inWay) this.score.inWay++;
      }
      if (t.id > 0 && dx < -0.6 && this.watched.get(t.id) === true) {
        if (!this.bumped.has(t.id)) this.score.cleared++;
        this.watched.set(t.id, false);
      }
      // Nearest point of the thing (a segment along the path for long things).
      const cx = Math.max(t.x - t.hx, Math.min(t.x + t.hx, w.x));
      const ex = cx - w.x;
      const d = Math.hypot(ex, dy);
      if (d >= t.r + BODY_R) continue;
      // Contact: they stop and back off (as you do when you walk into a post).
      const last = this.bumped.get(t.id) ?? -Infinity;
      if (now - last > 3000) {
        this.bumped.set(t.id, now);
        if (t.head) this.score.headBumps++;
        else this.score.bumps++;
        this.lastBump = { what: t.what, at: now };
        this.bumpLog.push({ what: t.what, x: Math.round(w.x), side: Math.round(dy * 100) / 100 });
        this.pause = 0.8;
        // Then step away from it, toward the middle of the path if it's ambiguous.
        const away = Math.abs(dy) > 0.05 ? -Math.sign(dy) : w.y > 0 ? -1 : 1;
        this.reflex = { side: away, until: now + 800 + 1400 };
      }
      const k = (t.r + BODY_R) / Math.max(1e-3, d);
      w.x = cx - ex * k;
      w.y = t.y - dy * k;
    }
    for (const id of this.bumped.keys()) if (now - this.bumped.get(id)! > 20000) this.bumped.delete(id);
  }

  private movePeople(dt: number): void {
    const w = this.walker;
    this.people = this.people.map((p) => {
      let vy = p.vy;
      if (p.role !== 'crossing') {
        // People make room for you (more if you are heading at them), and walk around things.
        const ahead = p.vx < 0 ? w.x - p.x : 0;
        const dy = p.y - w.y;
        if (p.role === 'oncoming' && ahead < 0 && ahead > -5 && Math.abs(dy) < 0.8) vy = (dy >= 0 ? 1 : -1) * 0.6;
        else vy = (p.lane - p.y) * 0.8;
        for (const o of this.obstacles(p.x - 3, p.x + 3)) {
          const along = (o.x - p.x) * Math.sign(p.vx);
          if (o.r > 0 && along > 0 && along < 2.5 && Math.abs(o.y - p.y) < o.r + 0.35) vy = (p.y >= o.y ? 1 : -1) * 0.7;
        }
      }
      const x = p.x + p.vx * dt, y = Math.max(-5, Math.min(5, p.y + vy * dt));
      const moved = Math.hypot(p.vx, vy) * dt;
      const q = { ...p, x, y, s: { speed: Math.abs(p.cruise), distance: p.s.distance + moved } };
      const gone = x < w.x - 3 || x > w.x + 45 || (p.role === 'crossing' && Math.abs(y) >= 4.9);
      return gone ? this.spawn(p.role) : q;
    });
  }

  // --- Rendering ----------------------------------------------------------

  /** Per-pixel ground rays for the (fixed) camera tilt: computed once, not every frame. */
  private rays: { pitch: number; gx: Float32Array; gz: Float32Array } | null = null;

  private groundTable(cam: CameraModel): { pitch: number; gx: Float32Array; gz: Float32Array } {
    if (this.rays && this.rays.pitch === cam.pitch) return this.rays;
    const gx = new Float32Array(W * H), gz = new Float32Array(W * H);
    for (let v = 0; v < H; v++)
      for (let u = 0; u < W; u++) {
        const gp = groundPoint(u + 0.5, v + 0.5, cam);
        gx[v * W + u] = gp ? gp.x : 0;
        gz[v * W + u] = gp ? gp.z : -1;
      }
    return (this.rays = { pitch: cam.pitch, gx, gz });
  }

  private render(cam: CameraModel): void {
    const d = this.img.data;
    // Step bounce moves the picture a few pixels; the ground table stays the base tilt.
    const bounce = Math.round(((cam.pitch - this.pitch) * Math.max(W, H)) / 2 / Math.tan((cam.fovDeg * Math.PI) / 360));
    const { gx, gz } = this.groundTable({ ...cam, pitch: this.pitch });
    const w = this.walker;
    const c = Math.cos(w.theta), s = Math.sin(w.theta);
    const leaves = this.obstacles(w.x - 2, w.x + 40).filter((o) => o.kind === 'leaves');
    for (let v = 0; v < H; v++) {
      for (let u = 0; u < W; u++) {
        const i = (v * W + u) * 4;
        const k0 = Math.min(H - 1, Math.max(0, v - bounce)) * W + u;
        const gpz = gz[k0], gpx = gx[k0];
        if (gpz < 0 || gpz > 90) {
          const k = v / H;
          d[i] = 125 + 80 * k;
          d[i + 1] = 170 + 45 * k;
          d[i + 2] = 218 + 20 * k;
          d[i + 3] = 255;
          continue;
        }
        const wx = w.x + gpz * c - gpx * s;
        const wy = w.y + gpz * s + gpx * c;
        const h = hash(Math.floor(wx * 9), Math.floor(wy * 9));
        let r: number, gg: number, b: number;
        if (Math.abs(wy) <= PATH_HALF) {
          // Concrete with expansion joints; a lighter kerb at the edges.
          const kerb = Math.abs(wy) > PATH_HALF - 0.1;
          const joint = (wx / 1.6) % 1 < 0.025 || (wx / 1.6) % 1 > 0.995;
          const n = (h - 0.5) * 16;
          r = (kerb ? 192 : 158) + n - (joint ? 38 : 0);
          gg = (kerb ? 190 : 155) + n - (joint ? 38 : 0);
          b = (kerb ? 184 : 148) + n - (joint ? 38 : 0);
          for (const L of leaves) {
            const e = ((wx - L.x) / 0.6) ** 2 + ((wy - L.y) / 0.38) ** 2;
            if (e < 1 && h > 0.25 + e * 0.4) {
              const t = hash(Math.floor(wx * 23), Math.floor(wy * 23));
              [r, gg, b] = t < 0.33 ? [150, 92, 38] : t < 0.66 ? [196, 146, 62] : [118, 68, 34];
            }
          }
        } else {
          const n = (h - 0.5) * 34;
          const stripe = Math.floor(wx / 2.5) % 2 === 0 ? 6 : -6;
          r = 70 + n + stripe;
          gg = 128 + n + stripe;
          b = 56 + n * 0.6;
        }
        const fade = Math.min(1, gpz / 70) * 0.45;
        d[i] = r + (150 - r) * fade;
        d[i + 1] = gg + (175 - gg) * fade;
        d[i + 2] = b + (200 - b) * fade;
        d[i + 3] = 255;
      }
    }
    this.ctx.putImageData(this.img, 0, 0);

    // Objects and people, far to near.
    const f = Math.max(W, H) / 2 / Math.tan((cam.fovDeg * Math.PI) / 360);
    const toCam = (x: number, y: number) => {
      const dx = x - w.x, dy = y - w.y;
      return { xr: -dx * s + dy * c, z: dx * c + dy * s };
    };
    const items: { z: number; draw: () => void }[] = [];
    for (const o of this.obstacles(w.x - 1, w.x + 60)) {
      if (o.kind === 'leaves') continue;
      const p = toCam(o.x, o.y);
      if (o.kind === 'bench') {
        if (p.z > -0.5) items.push({ z: p.z, draw: () => this.drawBench(o, cam, f, toCam) });
      } else if (p.z > 0.5) items.push({ z: p.z, draw: () => drawObstacle(this.ctx, o, p.xr, p.z, cam, f) });
    }
    for (const person of this.people) {
      const p = toCam(person.x, person.y);
      if (p.z < 0.8 || p.z > 50) continue;
      items.push({
        z: p.z,
        draw: () => {
          const feet = project(p.xr, 0, p.z, cam, f);
          if (!feet) return;
          shadow(this.ctx, p.xr, p.z, 0.45, cam, f);
          drawPerson(this.ctx, feet.u, feet.v, f / feet.zc, person, person.role === 'oncoming');
        },
      });
    }
    items.sort((a, b) => b.z - a.z).forEach((it) => it.draw());
  }
}



function hash(a: number, b: number): number {
  const h = Math.sin(a * 12.9898 + b * 78.233) * 43758.5453;
  return h - Math.floor(h);
}

/** Camera-frame point (right, up from the ground, forward) -> pixel. */
function project(xr: number, up: number, z: number, cam: CameraModel, f: number): { u: number; v: number; zc: number } | null {
  const c = Math.cos(cam.pitch), s = Math.sin(cam.pitch);
  const yd = cam.mountHeight - up; // down from the camera
  const yc = c * yd - s * z;
  const zc = s * yd + c * z;
  if (zc < 0.15) return null;
  return { u: cam.width / 2 + (f * xr) / zc, v: cam.height / 2 + (f * yc) / zc, zc };
}

function shadow(g: CanvasRenderingContext2D, xr: number, z: number, width: number, cam: CameraModel, f: number): void {
  const p = project(xr + 0.08, 0, z + 0.05, cam, f);
  if (!p) return;
  const rx = ((width * 0.75) * f) / p.zc;
  g.fillStyle = 'rgba(20,24,20,0.28)';
  g.beginPath();
  g.ellipse(p.u, p.v, rx, rx * 0.35, 0, 0, 2 * Math.PI);
  g.fill();
}

/** A shaded upright solid (cylinder look) from `bottom` to `top`, `wb`/`wt` wide at bottom/top. */
function solid(
  g: CanvasRenderingContext2D,
  xr: number,
  z: number,
  bottom: number,
  top: number,
  wb: number,
  wt: number,
  cam: CameraModel,
  f: number,
  colour: [number, number, number],
  bands: { from: number; to: number; colour: [number, number, number] }[] = [],
): void {
  const quad = (b: number, t: number, col: [number, number, number]) => {
    const kb = (b - bottom) / Math.max(1e-6, top - bottom), kt = (t - bottom) / Math.max(1e-6, top - bottom);
    const w0 = wb + (wt - wb) * kb, w1 = wb + (wt - wb) * kt;
    const bl = project(xr - w0 / 2, b, z, cam, f), br = project(xr + w0 / 2, b, z, cam, f);
    const tl = project(xr - w1 / 2, t, z, cam, f), tr = project(xr + w1 / 2, t, z, cam, f);
    if (!bl || !br || !tl || !tr) return;
    const grad = g.createLinearGradient(Math.min(bl.u, tl.u), 0, Math.max(br.u, tr.u), 0);
    const [r, gg, bb] = col;
    grad.addColorStop(0, `rgb(${r * 0.55},${gg * 0.55},${bb * 0.55})`);
    grad.addColorStop(0.3, `rgb(${Math.min(255, r * 1.12)},${Math.min(255, gg * 1.12)},${Math.min(255, bb * 1.12)})`);
    grad.addColorStop(1, `rgb(${r * 0.42},${gg * 0.42},${bb * 0.42})`);
    g.fillStyle = grad;
    g.beginPath();
    g.moveTo(bl.u, bl.v);
    g.lineTo(br.u, br.v);
    g.lineTo(tr.u, tr.v);
    g.lineTo(tl.u, tl.v);
    g.closePath();
    g.fill();
  };
  quad(bottom, top, colour);
  for (const band of bands) quad(band.from, band.to, band.colour);
}

function drawObstacle(g: CanvasRenderingContext2D, o: Obstacle, xr: number, z: number, cam: CameraModel, f: number): void {
  const ORANGE: [number, number, number] = [236, 104, 28], WHITE: [number, number, number] = [240, 240, 236];
  if (o.kind !== 'plate') shadow(g, xr, z, o.w, cam, f);
  switch (o.kind) {
    case 'pole': {
      solid(g, xr, z, 0, o.h, o.w, o.w * 0.7, cam, f, [70, 76, 86]);
      solid(g, xr + 0.12, z, o.h - 0.15, o.h, 0.42, 0.3, cam, f, [50, 54, 60]); // lamp head
      break;
    }
    case 'bollard':
      solid(g, xr, z, 0, o.h, o.w, o.w, cam, f, [58, 62, 72], [{ from: o.h - 0.22, to: o.h - 0.14, colour: [235, 220, 120] }]);
      break;
    case 'bin':
      solid(g, xr, z, 0, o.h, o.w, o.w * 1.05, cam, f, [30, 102, 58]);
      solid(g, xr, z, o.h - 0.08, o.h, o.w * 1.1, o.w * 1.1, cam, f, [24, 70, 40]);
      break;
    case 'cone':
      solid(g, xr, z, 0, 0.05, o.w * 1.3, o.w * 1.3, cam, f, [30, 30, 30]);
      solid(g, xr, z, 0.05, o.h, o.w, 0.05, cam, f, ORANGE, [
        { from: 0.3, to: 0.4, colour: WHITE },
        { from: 0.5, to: 0.57, colour: WHITE },
      ]);
      break;
    case 'barrel':
      // Like the barrel in Project Guideline's obstacle test frame.
      solid(g, xr, z, 0, 0.06, o.w * 1.3, o.w * 1.3, cam, f, [25, 25, 25]);
      solid(g, xr, z, 0.06, o.h, o.w, o.w * 0.92, cam, f, ORANGE, [
        { from: 0.35, to: 0.47, colour: WHITE },
        { from: 0.62, to: 0.74, colour: WHITE },
        { from: 0.89, to: 0.98, colour: WHITE },
      ]);
      break;
    case 'sign':
      solid(g, xr, z, 0, o.h, o.w, o.w, cam, f, [120, 124, 130]);
      break;
    case 'plate': {
      const tl = project(xr - o.w / 2, o.h, z, cam, f), br = project(xr + o.w / 2, o.bottom, z, cam, f);
      if (!tl || !br) break;
      g.fillStyle = '#f4f4f0';
      g.fillRect(tl.u, tl.v, br.u - tl.u, br.v - tl.v);
      const m = (br.u - tl.u) * 0.07;
      g.fillStyle = '#1d4ed8';
      g.fillRect(tl.u + m, tl.v + m, br.u - tl.u - 2 * m, br.v - tl.v - 2 * m);
      break;
    }
    case 'bench': {
      const brown: [number, number, number] = [122, 84, 50];
      solid(g, xr - o.w * 0.4, z, 0, 0.42, 0.07, 0.07, cam, f, [40, 40, 40]);
      solid(g, xr + o.w * 0.4, z, 0, 0.42, 0.07, 0.07, cam, f, [40, 40, 40]);
      solid(g, xr, z + 0.2, 0.5, o.h, o.w, o.w, cam, f, brown);
      solid(g, xr, z, 0.4, 0.48, o.w, o.w, cam, f, brown);
      break;
    }
    case 'rock': {
      const p = project(xr, o.h / 2, z, cam, f);
      if (!p) break;
      const rx = ((o.w / 2) * f) / p.zc, ry = ((o.h / 2) * f) / p.zc;
      const grad = g.createRadialGradient(p.u - rx * 0.3, p.v - ry * 0.4, 1, p.u, p.v, rx);
      grad.addColorStop(0, '#a8a29e');
      grad.addColorStop(1, '#44403c');
      g.fillStyle = grad;
      g.beginPath();
      g.ellipse(p.u, p.v, rx, ry * 1.1, 0, 0, 2 * Math.PI);
      g.fill();
      break;
    }
    case 'tree': {
      solid(g, xr, z, 0, 2.4, o.w, o.w * 0.8, cam, f, [92, 64, 44]);
      const p = project(xr, 3.4, z, cam, f);
      if (!p) break;
      const rad = (1.4 * f) / p.zc;
      const grad = g.createRadialGradient(p.u - rad * 0.3, p.v - rad * 0.3, 1, p.u, p.v, rad);
      grad.addColorStop(0, '#4d8a3a');
      grad.addColorStop(1, '#22451c');
      g.fillStyle = grad;
      g.beginPath();
      g.arc(p.u, p.v, rad, 0, 2 * Math.PI);
      g.fill();
      break;
    }
    case 'leaves':
      break;
  }
}
