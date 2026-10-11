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
  // Project Guideline's painted line (their model card: about RGB 144, 99, 205).
  purple: [144, 99, 205],
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

interface Other {
  /** Stadium lane to hold (0 = follow the course line at offset `off`). */
  lane: number;
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
  { shirt: '#f59e0b', shorts: '#0f172a', skin: '#e0ac69', height: 1.62 },
];

/**
 * Real-time track simulator, in the spirit of Project Guideline's Unreal
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

  constructor(
    courseId: CourseId,
    private readonly motion: MotionSensor | null,
    speed = 3.3,
  ) {
    this.course = courseId === 'road' ? road() : courseId === 'purple' ? road('purple') : stadium(3);
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
    if (this.halted) {
      this.haltedSince ||= now;
      if (now - this.haltedSince > 3000) {
        // Sighted helper: back to the nearest point on the line, facing along it.
        const back = this.course.lateral(this.runner.x, this.runner.y);
        const tan = this.course.tangent(this.runner.x, this.runner.y);
        this.runner = {
          ...this.runner,
          x: this.runner.x + Math.sin(tan) * back,
          y: this.runner.y - Math.cos(tan) * back,
          heading: tan,
        };
        this.rescues++;
        this.haltedSince = 0;
      }
    } else this.haltedSince = 0;

    // --- Steering --------------------------------------------------------
    let steer = (this.input.right ? 0.7 : 0) - (this.input.left ? 0.7 : 0);
    if (this.autopilot) {
      // Wanders (slowly varying random drift) and reacts ~0.3 s late to what it hears.
      this.wander += (-this.wander * 0.6 + (Math.random() - 0.5) * 2.2) * dt;
      this.reaction.push({ t: now, steer: this.guidance.steer * this.guidance.magnitude });
      while (this.reaction.length > 1 && now - this.reaction[0].t > 300) this.reaction.shift();
      const heard = this.reaction[0].steer;
      steer += this.wander * 0.35 + heard * 1.4;
    }
    if (dt > 0 && !this.halted) this.runner = stepRunner(this.runner, steer, dt);
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
        const paint = this.course.paintAt(wx, wy);
        const c = PAINT[paint];
        // Surface grain fixed to the ground, so it streams past as you run.
        const h = Math.sin(Math.floor(wx * 7) * 12.9898 + Math.floor(wy * 7) * 78.233) * 43758.5453;
        const n = paint === 'white' || paint === 'yellow' || paint === 'purple' ? ((h - Math.floor(h)) - 0.5) * 10 : ((h - Math.floor(h)) - 0.5) * 30;
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
 * An animated person seen from behind: legs and arms swing with their stride
 * (faster for runners), torso lean for runners, varied skin and clothing.
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
  const hPx = L.height * pxPerM;
  const running = o.s.speed > 1.8;
  const stride = running ? 1.15 : 0.75; // metres per step
  const phase = (o.s.distance / stride) * Math.PI;
  const swing = Math.sin(phase) * (running ? 0.55 : 0.3);
  const lean = running ? 0.06 * hPx : 0;
  const hipY = v - hPx * 0.5, shoulderY = v - hPx * 0.8, headR = hPx * 0.065;
  const limb = (x0: number, y0: number, len: number, ang: number, width: number, colour: string) => {
    g.strokeStyle = colour;
    g.lineWidth = Math.max(1, width);
    g.lineCap = 'round';
    g.beginPath();
    g.moveTo(x0, y0);
    g.lineTo(x0 + Math.sin(ang) * len * 0.35, y0 + Math.cos(ang) * len);
    g.stroke();
  };
  const w = hPx * 0.075;
  // Legs (back leg first), shoes at the end.
  limb(u - w * 0.4, hipY, hPx * 0.48, -swing, w, L.skin);
  limb(u + w * 0.4, hipY, hPx * 0.48, swing, w, L.skin);
  g.fillStyle = L.shorts;
  g.fillRect(u - w * 1.3, hipY - hPx * 0.02, w * 2.6, hPx * 0.13);
  // Torso
  g.fillStyle = L.shirt;
  g.beginPath();
  g.moveTo(u - w * 1.4, hipY);
  g.lineTo(u + w * 1.4, hipY);
  g.lineTo(u + w * 1.5 + lean * 0.2, shoulderY);
  g.lineTo(u - w * 1.5 + lean * 0.2, shoulderY);
  g.closePath();
  g.fill();
  // Arms swing opposite to the legs.
  limb(u - w * 1.6, shoulderY + hPx * 0.02, hPx * 0.33, swing * 0.9, w * 0.7, L.skin);
  limb(u + w * 1.6, shoulderY + hPx * 0.02, hPx * 0.33, -swing * 0.9, w * 0.7, L.skin);
  // Head, a little bob with each step.
  const bob = Math.abs(Math.sin(phase)) * hPx * (running ? 0.015 : 0.006);
  g.fillStyle = L.skin;
  g.beginPath();
  g.arc(u + lean * 0.3, shoulderY - headR * 1.1 - bob, headR, 0, 2 * Math.PI);
  g.fill();
  g.fillStyle = '#1f1f1f'; // hair
  g.beginPath();
  if (front) g.arc(u + lean * 0.3, shoulderY - headR * 1.75 - bob, headR * 0.75, Math.PI, 2 * Math.PI);
  else g.arc(u + lean * 0.3, shoulderY - headR * 1.35 - bob, headR * 0.85, Math.PI, 2 * Math.PI);
  g.fill();
}
