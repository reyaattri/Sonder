import type { FrameSource } from '../camera/source';
import type { MotionSensor } from '../sensors/motion';
import { groundPoint, imagePoint, type CameraModel } from '../track/world';
import { road, stadium, stepRunner, wrap, type Course, type CourseId, type Paint, type RunnerState } from './course';

/** Simulated chest camera: portrait phone, 65 deg long-side field of view. */
const W = 240, H = 320;
const FPS = 60;

const PAINT: Record<Paint, [number, number, number]> = {
  white: [238, 238, 236],
  yellow: [236, 196, 36],
  track: [178, 72, 56],
  road: [74, 74, 78],
  grass: [70, 128, 58],
};

export interface Guidance {
  /** -1..1, + = steer right (what the app's guide tone is saying). */
  steer: number;
  /** 0..1, how insistent (silent = 0). */
  magnitude: number;
}

/** One scripted case in the "show every case" demo. */
interface DemoStep {
  id: 'center' | 'drift' | 'big' | 'runner' | 'person' | 'gap';
  seconds: number;
  title: string;
  /** What EchoPath should do (shown on screen). */
  expect: (road: boolean) => string;
}

const DEMO: DemoStep[] = [
  { id: 'center', seconds: 7, title: 'On the line', expect: () => 'Silent while you are centred. No sound means on line.' },
  { id: 'drift', seconds: 9, title: 'Slow drift to the left', expect: () => 'A soft steering sound in the RIGHT ear, with a rumble on that side: turn right. It fades as you come back.' },
  { id: 'big', seconds: 12, title: 'Big drift: 1 metre to the right', expect: (road) => (road ? 'Warning sound and a buzz in the LEFT ear, then "Move left." spoken once.' : 'Over the lane line into the next lane: STOP. A guide walks you back, then "Line found. Go."') },
  { id: 'runner', seconds: 13, title: 'A slower runner ahead', expect: (road) => `Approach sound and "Someone ahead, a few metres."${road ? ' On a road it says which side to pass.' : ' In a lane: ease off behind them.'}` },
  { id: 'person', seconds: 14, title: 'Someone standing on the line', expect: (road) => (road ? 'Obstacle sound and "Pass on the left/right." The runner goes round them.' : 'Obstacle sound and "Someone ahead." The runner slows and stops; they step aside.') },
  { id: 'gap', seconds: 14, title: 'The painted line is worn away', expect: () => 'STOP when the line is lost while running. "Go" as soon as it is found again.' },
];

interface Other {
  /** Stadium lane to hold (0 = follow the course line at offset `off`). */
  lane: number;
  /** Added by the demo (removed when the step ends). */
  demo?: boolean;
  /** Lateral offset from the course line to hold (m, + right). */
  off?: number;
  s: RunnerState;
  look: Look;
}

export interface Look {
  shirt: string;
  shorts: string;
  skin: string;
  height: number;
}

export const LOOKS: Look[] = [
  { shirt: '#1d4ed8', shorts: '#111827', skin: '#8d5524', height: 1.78 },
  { shirt: '#047857', shorts: '#374151', skin: '#f1c27d', height: 1.68 },
  { shirt: '#be123c', shorts: '#1f2937', skin: '#c68642', height: 1.74 },
  { shirt: '#4b5563', shorts: '#1e293b', skin: '#e0ac69', height: 1.66 },
];

/**
 * Real-time track simulator, in the spirit of the guide-line system's Unreal
 * simulator: a runner on a real-geometry course, rendered from a chest
 * camera at 60 fps into a canvas whose video stream feeds EchoPath's REAL
 * pipeline (lane detection, world model, feedback, audio). It also feeds the
 * motion sensor with step bounce, camera tilt and turn rate.
 *
 * Steering: by hand (arrow keys / buttons), or an autopilot that behaves
 * like a blind runner: it wanders a little, cannot see bends, and corrects
 * only when it HEARS EchoPath's guidance. If the system works, the
 * autopilot stays in its lane all the way round.
 */
export class TrackSimulator {
  readonly canvas = Object.assign(document.createElement('canvas'), { width: W, height: H });
  readonly video = document.createElement('video');
  course: Course;
  runner: RunnerState;
  others: Other[] = [];
  autopilot = true;
  /** Frozen until guidance is actually running (e.g. during the countdown). */
  frozen = true;
  /** The runner obeys STOP: stands still; after a few seconds a "sighted helper" puts them back on the line. */
  halted = false;
  private haltedSince = 0;
  /** Times the runner had to be helped back after a STOP (a score: lower is better). */
  rescues = 0;
  input = { left: false, right: false };
  /** Latest guidance from EchoPath (set by the app each frame). */
  guidance: Guidance = { steer: 0, magnitude: 0 };
  pitch = 0.4;
  mountHeight = 1.3;
  fovDeg = 65;
  private ctx = this.canvas.getContext('2d')!;
  private img = this.ctx.createImageData(W, H);
  private timer: number | undefined;
  private lastT = 0;
  private wander = 0;
  private reaction: { t: number; steer: number }[] = [];
  private stream: MediaStream | null = null;
  private stepPhase = 0;
  /** Ground-truth history for scoring (lateral error, metres). */
  readonly truth: { t: number; lateral: number }[] = [];
  /** Someone ahead that EchoPath reported (set by the app): the runner follows "pass on the ..." */
  ahead: { distance: number; side: 'left' | 'right' } | null = null;
  /** "Show every case" demo state. */
  private demo: { step: number; since: number } | null = null;
  /** Worn-away paint: along-course distance range with no line. */
  private gap: [number, number] | null = null;
  /** Demo: slide sideways at `slide` m/s until `until` (a controlled drift). */
  private forced: { slide: number; until: number } | null = null;
  private holdUntil = 0;
  private calm = false;
  private helping = false;
  private recentre = false;

  /** Start / stop the scripted demo of every case. */
  /** Background people, set aside while the demo runs so each case is clean. */
  private background: Other[] = [];

  setDemo(on: boolean): void {
    this.others = this.others.filter((o) => !o.demo);
    if (on) {
      this.background = this.others;
      this.others = [];
    } else if (this.background.length) {
      this.others = this.background;
      this.background = [];
    }
    this.gap = null;
    this.forced = null;
    this.calm = false;
    this.demo = on ? { step: -1, since: 0 } : null;
  }

  /** Called once every case has been shown. */
  onDemoDone: (() => void) | null = null;

  get demoOn(): boolean {
    return this.demo !== null;
  }

  /** What the demo is showing now (for the screen). */
  demoStatus(): { n: number; total: number; title: string; expect: string } | null {
    if (!this.demo || this.demo.step < 0) return null;
    const st = DEMO[this.demo.step];
    return { n: this.demo.step + 1, total: DEMO.length, title: st.title, expect: st.expect(this.course.id === 'road') };
  }

  /** Move the runner sideways so they are `target` metres from the line (+ right). */
  private placeAt(target: number): void {
    const tan = this.course.tangent(this.runner.x, this.runner.y);
    const d = target - this.lateral;
    let best = this.runner;
    for (const k of [1, -1]) {
      const c = { ...this.runner, x: this.runner.x + k * Math.sin(tan) * d, y: this.runner.y - k * Math.cos(tan) * d, heading: tan };
      if (Math.abs(this.course.lateral(c.x, c.y) - target) < Math.abs(this.course.lateral(best.x, best.y) - target)) best = c;
    }
    this.runner = best;
  }

  /** Someone on the course `ahead` metres in front, at `off` from the line. */
  private addAhead(ahead: number, speed: number, off: number, look: Look): void {
    // Walk along the course's own direction (it bends), then step onto the line.
    let x = this.runner.x, y = this.runner.y;
    for (let d = 0; d < ahead; d += 0.5) {
      const t = this.course.tangent(x, y);
      x += Math.cos(t) * 0.5;
      y += Math.sin(t) * 0.5;
    }
    const t = this.course.tangent(x, y);
    const fix = off - this.course.lateral(x, y);
    let best = { x, y };
    for (const k of [1, -1]) {
      const c = { x: x + k * Math.sin(t) * fix, y: y - k * Math.cos(t) * fix };
      if (Math.abs(this.course.lateral(c.x, c.y) - off) < Math.abs(this.course.lateral(best.x, best.y) - off)) best = c;
    }
    const s0 = { ...this.runner, x: best.x, y: best.y, heading: t, speed, distance: 0, turnRate: 0 };
    this.others.push({ lane: this.course.lane, off, s: s0, look, demo: true });
  }

  private demoTick(now: number): void {
    const d = this.demo!;
    const road = this.course.id === 'road';
    if (d.step < 0 || now - d.since > DEMO[d.step].seconds * 1000) {
      if (d.step === DEMO.length - 1) {
        // All cases shown once: back to normal running on the line.
        this.setDemo(false);
        if (Math.abs(this.lateral) > 0.05) this.recentre = true;
        this.onDemoDone?.();
        return;
      }
      d.step += 1;
      d.since = now;
      this.others = this.others.filter((o) => !o.demo);
      this.gap = null;
      this.forced = null;
      this.calm = true;
      const id = DEMO[d.step].id;
      // Every case starts centred: a small nudge, or walked back if far off
      // (never a jump across a lane line the camera did not see).
      if (Math.abs(this.lateral) < 0.3) this.placeAt(0);
      else this.recentre = true;
      if (id === 'drift') {
        // Drift 0.4 m to the left over 2 s, not hearing EchoPath meanwhile; then it guides them back.
        this.forced = { slide: -0.14, until: now + 2000 };
        this.holdUntil = now + 2000;
      }
      if (id === 'big') {
        // A fast 1 m drift to the right over 2 s (a real drift, not a jump), then
        // a moment more before reacting, so EchoPath judges it a big drift.
        this.forced = { slide: 0.5, until: now + 2000 };
        this.holdUntil = now + 3200;
      }
      if (id === 'runner') this.addAhead(14, Math.max(1.5, this.runner.speed - 1.2), 0, LOOKS[1]);
      if (id === 'person') this.addAhead(22, 0, 0, LOOKS[3]);
      if (id === 'gap') this.gap = [this.runner.distance + 9, this.runner.distance + 30];
    }
    const id = DEMO[d.step].id;
    // The person standing on the line steps aside once the runner has stopped near them.
    if (id === 'person' && !road)
      for (const o of this.others)
        if (o.demo && Math.hypot(o.s.x - this.runner.x, o.s.y - this.runner.y) < 3 && this.runner.speed > 0) o.off = 1.6;
    // Worn paint: once EchoPath has stopped the runner, the line "comes back" a moment later.
    if (id === 'gap' && this.gap && this.halted && this.haltedSince && now - this.haltedSince > 1800) {
      this.gap = null;
      this.haltedSince = 0; // EchoPath says go by itself: no helper needed
    }
  }

  constructor(
    courseId: CourseId,
    private readonly motion: MotionSensor | null,
    speed = 3.3,
  ) {
    this.course = courseId === 'road' ? road() : stadium(3);
    this.runner = { ...this.course.start(), speed, turnRate: 0, distance: 0 };
    const at = (dx: number, dy: number, speed: number) => ({ ...this.runner, x: this.runner.x + dx, y: this.runner.y + dy, speed, distance: 0, turnRate: 0 });
    if (courseId === 'stadium') {
      // Runners ahead: one in your lane (you'll catch them), one in lane 4, one in lane 2.
      this.others = [
        { lane: 3, s: at(35, 0, 2.9), look: LOOKS[0] },
        { lane: 4, s: at(18, -1.22, 3.1), look: LOOKS[1] },
        { lane: 2, s: at(55, 1.22, 2.7), look: LOOKS[2] },
      ];
    } else {
      // Road: a slower runner on the line, a walker on the right shoulder,
      // a jogger on the left - the kind of people a road race really has.
      this.others = [
        { lane: 0, off: 0, s: at(28, 0, 2.6), look: LOOKS[0] },
        { lane: 0, off: 2.3, s: at(14, -2.3, 1.3), look: LOOKS[3] },
        { lane: 0, off: -2.5, s: at(40, 2.5, 2.2), look: LOOKS[2] },
      ];
    }
  }

  setCourse(id: CourseId): void {
    const speed = this.runner.speed;
    const fresh = new TrackSimulator(id, null, speed);
    this.course = fresh.course;
    this.runner = fresh.runner;
    this.others = fresh.others;
    this.truth.length = 0;
  }

  /** A FrameSource the real pipeline reads from, exactly like a camera. */
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

  get lateral(): number {
    return this.course.lateral(this.runner.x, this.runner.y);
  }

  /** Simulated camera model for the current frame. */
  camera(): CameraModel {
    return { width: W, height: H, fovDeg: this.fovDeg, pitch: this.pitch, mountHeight: this.mountHeight };
  }

  private tick(): void {
    const now = performance.now();
    let dt = Math.min(0.05, (now - this.lastT) / 1000);
    this.lastT = now;
    if (dt <= 0) return;
    if (this.frozen) dt = 0; // render the view, but nobody moves yet
    if (this.demo && dt > 0) this.demoTick(now);
    if (this.halted && this.demo && this.gap) {
      // Demo, worn paint: the STOP holds until the line is back.
      this.haltedSince ||= now;
    } else if (this.halted) {
      this.haltedSince ||= now;
      if (now - this.haltedSince > 3000 && !this.helping) {
        this.helping = true;
        this.rescues++;
      }
      // Sighted helper walks them back to the line over a second or two (the
      // camera sees it happen, as it would for real), facing along the course.
      if ((this.helping || this.recentre) && dt > 0) {
        const lat = this.lateral;
        this.placeAt(lat - Math.sign(lat) * Math.min(Math.abs(lat), 0.6 * dt));
      }
    } else {
      this.haltedSince = 0;
      this.helping = false;
      if (this.recentre && dt > 0) {
        const lat = this.lateral;
        this.placeAt(lat - Math.sign(lat) * Math.min(Math.abs(lat), 0.8 * dt));
        if (Math.abs(this.lateral) < 0.05) this.recentre = false;
      }
    }

    // --- Steering --------------------------------------------------------
    let steer = (this.input.right ? 0.7 : 0) - (this.input.left ? 0.7 : 0);
    let pace = 1;
    if (this.autopilot) {
      // Wanders (slowly varying random drift) and reacts ~0.3 s late to what it hears.
      this.wander += (-this.wander * 0.6 + (Math.random() - 0.5) * 2.2) * dt;
      if (this.calm) this.wander *= 0.9; // the demo shows each case cleanly
      this.reaction.push({ t: now, steer: this.guidance.steer * this.guidance.magnitude });
      while (this.reaction.length > 1 && now - this.reaction[0].t > 300) this.reaction.shift();
      const heard = now < this.holdUntil ? 0 : this.reaction[0].steer;
      steer += this.wander * 0.35 + heard * 1.4;
      // Someone ahead: on a road, go round them about 0.9 m to the side EchoPath
      // says; in a lane, ease off behind them.
      if (this.ahead && this.ahead.distance < 7) {
        if (this.course.id === 'road') {
          const target = this.ahead.side === 'right' ? 0.9 : -0.9;
          const err = wrap(this.course.tangent(this.runner.x, this.runner.y) - this.runner.heading);
          steer = -err * 4 - 1.5 * (this.lateral - target);
        } else pace = Math.max(0, Math.min(1, (this.ahead.distance - 1.6) / 3));
      }
    }
    if (this.forced && now < this.forced.until && dt > 0) {
      this.placeAt(this.lateral + this.forced.slide * dt);
      steer = 0;
    }
    if (dt > 0 && !this.halted && pace > 0) {
      const next = stepRunner({ ...this.runner, speed: this.runner.speed * pace }, steer, dt);
      this.runner = { ...next, speed: this.runner.speed };
    }
    for (const o of this.others) {
      // Other people hold their lane / line offset.
      const c = o.lane > 0 && o.lane !== this.course.lane ? stadium(o.lane) : this.course;
      const err = wrap(c.tangent(o.s.x, o.s.y) - o.s.heading);
      if (dt > 0) o.s = stepRunner(o.s, -err * 4 - 1.5 * (c.lateral(o.s.x, o.s.y) - (o.off ?? 0)), dt);
    }
    if (dt > 0) this.truth.push({ t: now, lateral: this.lateral });
    if (this.truth.length > 3600) this.truth.shift();

    // --- Sensors: step bounce, tilt and turn rate ------------------------
    const cadenceHz = this.runner.speed / 1.1; // steps per second at ~1.1 m per step
    this.stepPhase += 2 * Math.PI * (dt > 0 ? cadenceHz : 0) * dt;
    const bob = 0.012 * Math.sin(this.stepPhase);
    const p = this.pitch + bob;
    if (this.motion) {
      const g = 9.81 + 5 * Math.sin(this.stepPhase);
      const up = { x: 0, y: Math.cos(p), z: Math.sin(p) };
      const rightRateDeg = (-this.runner.turnRate * 180) / Math.PI;
      this.motion.ingest({ x: up.x * g, y: up.y * g, z: up.z * g }, { alpha: -rightRateDeg * up.z, beta: 0, gamma: -rightRateDeg * up.y }, now);
    }

    this.render({ ...this.camera(), pitch: p });
  }

  private render(cam: CameraModel): void {
    const d = this.img.data;
    const { x: px, y: py, heading } = this.runner;
    const fx = Math.cos(heading), fy = Math.sin(heading);
    const rx = Math.sin(heading), ry = -Math.cos(heading); // your right, in world terms
    for (let v = 0; v < H; v++) {
      for (let u = 0; u < W; u++) {
        const i = (v * W + u) * 4;
        const gp = groundPoint(u + 0.5, v + 0.5, cam);
        if (!gp || gp.z > 120) {
          // Sky, a little lighter toward the horizon.
          const k = v / H;
          d[i] = 120 + 80 * k;
          d[i + 1] = 165 + 50 * k;
          d[i + 2] = 215 + 20 * k;
          d[i + 3] = 255;
          continue;
        }
        const wx = px + gp.z * fx + gp.x * rx;
        const wy = py + gp.z * fy + gp.x * ry;
        let paint = this.course.paintAt(wx, wy);
        // Worn-away paint in the demo: no line over that stretch.
        if (this.gap && (paint === 'white' || paint === 'yellow')) {
          const along = this.runner.distance + gp.z;
          if (along > this.gap[0] && along < this.gap[1]) paint = this.course.id === 'road' ? 'road' : 'track';
        }
        const c = PAINT[paint];
        // Surface grain fixed to the ground, so it streams past as you run.
        const h = Math.sin(Math.floor(wx * 7) * 12.9898 + Math.floor(wy * 7) * 78.233) * 43758.5453;
        const n = paint === 'white' || paint === 'yellow' ? ((h - Math.floor(h)) - 0.5) * 10 : ((h - Math.floor(h)) - 0.5) * 30;
        const fade = Math.min(1, gp.z / 60); // haze in the distance
        d[i] = c[0] + n + (150 - c[0]) * fade * 0.4;
        d[i + 1] = c[1] + n + (175 - c[1]) * fade * 0.4;
        d[i + 2] = c[2] + n + (200 - c[2]) * fade * 0.4;
        d[i + 3] = 255;
      }
    }
    this.ctx.putImageData(this.img, 0, 0);
    // Other runners as simple figures, nearest drawn last.
    const toCam = (o: RunnerState) => {
      const dx = o.x - px, dy = o.y - py;
      return { x: dx * rx + dy * ry, z: dx * fx + dy * fy };
    };
    const vis = this.others
      .map((o) => ({ o, c: toCam(o.s) }))
      .filter((v) => v.c.z > 1.2 && v.c.z < 60)
      .sort((a, b) => b.c.z - a.c.z);
    for (const { o, c } of vis) {
      const feet = imagePoint(c, cam);
      if (feet) drawPerson(this.ctx, feet.u, feet.v, (Math.max(W, H) / 2 / Math.tan((cam.fovDeg * Math.PI) / 360)) / c.z, o);
    }
  }
}

/**
 * An animated person with realistic human proportions and shading (so the
 * real object detector recognises them, as it would a person in a photo):
 * tapered legs and arms that swing with the stride, shoulders wider than
 * hips, neck, head and hair, shoes, clothing folds, soft shading and a
 * ground shadow. Seen from behind, or from the front (face showing).
 */
export function drawPerson(
  g: CanvasRenderingContext2D,
  u: number,
  v: number,
  pxPerM: number,
  o: { look: Look; s: { speed: number; distance: number } },
  /** Seen from the front (walking toward you): face showing, hair only on top. */
  front = false,
): void {
  const L = o.look;
  const H = L.height * pxPerM;
  if (H < 4) return;
  const running = o.s.speed > 1.8;
  // Standing: feet apart, arms a little out (a relaxed real stance, not a column).
  const standing = o.s.speed < 0.3;
  const stride = running ? 1.15 : 0.75;
  const phase = (o.s.distance / stride) * Math.PI;
  // Walkers and people standing wear trousers; runners wear shorts.
  const legColour = running ? L.skin : L.shorts;
  const swing = Math.sin(phase) * (running ? 0.5 : 0.28);
  const bob = Math.abs(Math.sin(phase)) * H * (running ? 0.012 : 0.005);
  const y = (f: number) => v - f * H - (f > 0.45 ? bob : 0); // height fraction -> pixel row
  const shade = (hex: string, k: number) => {
    const n = parseInt(hex.slice(1), 16);
    const c = (sh: number) => Math.max(0, Math.min(255, Math.round(((n >> sh) & 255) * k)));
    return `rgb(${c(16)},${c(8)},${c(0)})`;
  };
  const fillGrad = (x0: number, x1: number, base: string) => {
    const gr = g.createLinearGradient(x0, 0, x1, 0);
    gr.addColorStop(0, shade(base, 0.62));
    gr.addColorStop(0.35, shade(base, 1.08));
    gr.addColorStop(1, shade(base, 0.55));
    return gr;
  };
  /** Tapered limb from (x0,y0) of width w0 to (x1,y1) of width w1. */
  const limb = (x0: number, y0: number, x1: number, y1: number, w0: number, w1: number, colour: string) => {
    const dx = x1 - x0, dy = y1 - y0, len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len, ny = dx / len;
    g.fillStyle = fillGrad(Math.min(x0, x1) - w0, Math.max(x0, x1) + w0, colour);
    g.beginPath();
    g.moveTo(x0 + (nx * w0) / 2, y0 + (ny * w0) / 2);
    g.lineTo(x1 + (nx * w1) / 2, y1 + (ny * w1) / 2);
    g.lineTo(x1 - (nx * w1) / 2, y1 - (ny * w1) / 2);
    g.lineTo(x0 - (nx * w0) / 2, y0 - (ny * w0) / 2);
    g.closePath();
    g.fill();
    // Rounded joints.
    g.beginPath();
    g.arc(x1, y1, w1 / 2, 0, 2 * Math.PI);
    g.arc(x0, y0, w0 / 2, 0, 2 * Math.PI);
    g.fill();
  };
  // Ground shadow.
  g.fillStyle = 'rgba(0,0,0,0.28)';
  g.beginPath();
  g.ellipse(u + H * 0.04, v, H * 0.16, H * 0.035, 0, 0, 2 * Math.PI);
  g.fill();

  const hipY = y(0.52), kneeY = y(0.28), shoulderY = y(0.815);
  const hipW = H * 0.19, shW = H * 0.26;
  // Legs: thigh -> knee -> ankle, swinging forward/back (seen as a small sideways and up/down shift).
  const leg = (side: number, sw: number) => {
    const hx = u + side * hipW * 0.25 + (standing ? side * H * 0.03 : 0);
    const kx = hx + sw * H * 0.06 + (standing ? side * H * 0.012 : 0), ky = kneeY - Math.abs(sw) * H * 0.02;
    const ax = hx + sw * H * 0.1 + (standing ? side * H * 0.025 : 0), ay = v - H * 0.035 - Math.max(0, sw) * H * 0.05;
    limb(hx, hipY, kx, ky, H * 0.095, H * 0.068, legColour);
    limb(kx, ky, ax, ay, H * 0.068, H * 0.045, legColour);
    // Shoe.
    g.fillStyle = '#1b1b1b';
    g.beginPath();
    g.ellipse(ax, ay + H * 0.018, H * 0.036, H * 0.022, 0, 0, 2 * Math.PI);
    g.fill();
  };
  leg(-1, -swing);
  leg(1, swing);
  // Shorts over the thighs.
  g.fillStyle = fillGrad(u - hipW * 0.62, u + hipW * 0.62, L.shorts);
  g.beginPath();
  g.moveTo(u - hipW * 0.58, y(0.57));
  g.lineTo(u + hipW * 0.58, y(0.57));
  g.lineTo(u + hipW * 0.62, y(0.4));
  g.lineTo(u + hipW * 0.04, y(0.42));
  g.lineTo(u - hipW * 0.04, y(0.42));
  g.lineTo(u - hipW * 0.62, y(0.4));
  g.closePath();
  g.fill();
  // Arms swing opposite to the legs, from the shoulder to the hand.
  const arm = (side: number, sw: number) => {
    const sx = u + side * shW * 0.46, sy = shoulderY + H * 0.015;
    const ex = sx + side * H * 0.012 - sw * H * 0.07, ey = y(0.64);
    const hx = ex - sw * H * 0.06 + side * H * (standing ? 0.04 : 0.008), hy = y(running ? 0.56 : 0.47);
    limb(sx, sy, ex, ey, H * 0.06, H * 0.045, L.shirt); // short sleeve
    limb(ex, ey, hx, hy, H * 0.042, H * 0.034, L.skin);
  };
  arm(-1, -swing);
  arm(1, swing);
  // Torso: shoulders wider than the waist, rounded.
  g.fillStyle = fillGrad(u - shW / 2, u + shW / 2, L.shirt);
  g.beginPath();
  g.moveTo(u - hipW * 0.6, y(0.56));
  g.quadraticCurveTo(u - shW * 0.5, y(0.68), u - shW * 0.5, shoulderY + H * 0.02);
  g.quadraticCurveTo(u - shW * 0.48, shoulderY - H * 0.012, u - shW * 0.2, shoulderY - H * 0.014);
  g.lineTo(u + shW * 0.2, shoulderY - H * 0.014);
  g.quadraticCurveTo(u + shW * 0.48, shoulderY - H * 0.012, u + shW * 0.5, shoulderY + H * 0.02);
  g.quadraticCurveTo(u + shW * 0.5, y(0.68), u + hipW * 0.6, y(0.56));
  g.closePath();
  g.fill();
  // Neck and head.
  const headR = H * 0.062, headY = y(0.9);
  limb(u, shoulderY, u, headY + headR * 0.6, H * 0.05, H * 0.045, L.skin);
  const hg = g.createRadialGradient(u - headR * 0.3, headY - headR * 0.3, headR * 0.2, u, headY, headR * 1.15);
  hg.addColorStop(0, shade(L.skin, 1.12));
  hg.addColorStop(1, shade(L.skin, 0.7));
  g.fillStyle = hg;
  g.beginPath();
  g.ellipse(u, headY, headR * 0.86, headR, 0, 0, 2 * Math.PI);
  g.fill();
  // Hair: covers the back of the head; from the front only the top.
  g.fillStyle = '#22180f';
  g.beginPath();
  if (front) g.ellipse(u, headY - headR * 0.55, headR * 0.86, headR * 0.5, 0, Math.PI, 2 * Math.PI);
  else g.ellipse(u, headY - headR * 0.12, headR * 0.9, headR * 0.95, 0, Math.PI * 0.92, Math.PI * 2.08);
  g.fill();
  if (front) {
    // Eyes and mouth hints.
    g.fillStyle = 'rgba(30,20,15,0.8)';
    g.fillRect(u - headR * 0.4, headY - headR * 0.1, headR * 0.18, headR * 0.1);
    g.fillRect(u + headR * 0.22, headY - headR * 0.1, headR * 0.18, headR * 0.1);
    g.fillRect(u - headR * 0.2, headY + headR * 0.42, headR * 0.4, headR * 0.07);
  }
}
