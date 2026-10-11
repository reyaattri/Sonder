/**
 * The guide-line system's sound design, ported to Web Audio, using its
 * recorded sound pack (Apache-2.0, downloaded into /sounds/pg by the asset
 * script). Mirrors project_guideline/audio/legacy_sound_pack.cc:
 *
 *  - STEERING loop: volume swings to one ear as the needed turn grows
 *    (full at 45 deg), shaped by a sensitivity curve (0.4) so small
 *    deviations stay quiet; plays faster/higher for bigger corrections.
 *  - WARNING loop: fades in from 40 % of the warning distance (0.6 m off the
 *    line) to full at 1.5 m.
 *  - TURN loop: a bend coming up ~3 m ahead, in the ear of the turn.
 *  - OBSTACLE loop replaces everything while something is in the way.
 *  - STOP: a one-shot.
 *
 * EchoPath's addition: an "ear vibration" - a low, buzzing rumble in the
 * SAME ear as the steering sound (the side you need to turn toward), which
 * headphone drivers reproduce as a felt vibration, together with the
 * phone's own vibration.
 */

export interface GuideSignal {
  /** Turn needed to reach the target point, degrees; + = turn RIGHT. */
  steerDeg: number;
  /** You relative to the line, metres; + = you are RIGHT of it. */
  lateralM: number;
  /** Turn of the line ~3 m ahead, degrees; + = bends RIGHT. */
  turnAheadDeg: number;
  obstacle: boolean;
  active: boolean;
}

const FILES = {
  steering: 'legacy_v4_2_steering',
  warning: 'legacy_v4_2_warning',
  stop: 'legacy_v4_2_stop',
  obstacle: 'obstacle',
  turn: 'turn',
  ready: 'ready',
} as const;
type SoundName = keyof typeof FILES;

const MAX_ROTATION_DEG = 45;
const SENSITIVITY = 0.4;
const WARNING_M = 1.5;
const WARNING_START = 0.4;
const TURN_SENSITIVITY = 0.5;
/**
 * Calm: the steering sound is SILENT until the correction is real (the
 * original design ticks quietly even on the line), then fades in.
 */
const STEER_QUIET = 0.12;
const STEER_FULL = 0.45;

const lerp = (x: number, x0: number, x1: number, y0: number, y1: number, gamma = 1) => {
  const t = Math.max(0, Math.min(1, (x - x0) / (x1 - x0)));
  return y0 + (y1 - y0) * Math.pow(t, gamma);
};

/** The guide-line system's ApplyShaping: piecewise-linear S-curve that keeps small inputs small. */
export function applyShaping(x: number, curvature = SENSITIVITY): number {
  if (curvature === 0) return x;
  const mid = lerp(curvature, 0, 1, 0.5, 0.01);
  if (x < -0.5) return lerp(x, -1, -0.5, -1, -mid);
  if (x < 0) return lerp(x, -0.5, 0, -mid, 0);
  if (x < 0.5) return lerp(x, 0, 0.5, 0, mid);
  return lerp(x, 0.5, 1, mid, 1);
}

/** Steering: hard-pan toward the turn side (+ = right ear). Returns [left, right] volumes. */
export function steerPan(pos: number): [number, number] {
  // PG's V0 "LegacyHardPan" in our sign convention (+ = turn right).
  return [lerp(-pos, -0.1, 1, 0, 1), lerp(-pos, -1, 0.1, 1, 0)];
}

/** Warning: silent below the threshold, then in the ear of the side to move toward. */
export function warningPan(pos: number, threshold = WARNING_START): [number, number] {
  const v = lerp(Math.abs(pos), threshold, 1, 0, 1);
  // pos + = you are right of the line -> move left -> left ear.
  return [pos > 0 ? v : 0, pos < 0 ? v : 0];
}

interface Loop {
  src: AudioBufferSourceNode;
  l: GainNode;
  r: GainNode;
}

export class PgSoundPack {
  loaded = false;
  private buffers = new Map<SoundName, AudioBuffer>();
  private loops = new Map<SoundName, Loop>();
  private rumble: { l: GainNode; r: GainNode } | null = null;
  private bus: GainNode | null = null;

  constructor(private readonly base: string) {}

  /** Load and decode the sound pack (Ogg Vorbis). Resolves false if the browser can't decode it. */
  async load(ctx: AudioContext, dest: AudioNode): Promise<boolean> {
    try {
      await Promise.all(
        (Object.keys(FILES) as SoundName[]).map(async (k) => {
          const res = await fetch(new URL(`sounds/pg/${FILES[k]}.ogg`, this.base));
          this.buffers.set(k, await ctx.decodeAudioData(await res.arrayBuffer()));
        }),
      );
    } catch (e) {
      console.warn('[EchoPath] guide-line sounds unavailable:', e);
      return false;
    }
    this.bus = ctx.createGain();
    this.bus.connect(dest);
    for (const k of ['steering', 'warning', 'turn', 'obstacle'] as SoundName[]) this.loops.set(k, this.makeLoop(ctx, k));
    this.rumble = this.makeRumble(ctx);
    this.loaded = true;
    return true;
  }

  private makeLoop(ctx: AudioContext, k: SoundName): Loop {
    const src = ctx.createBufferSource();
    src.buffer = this.buffers.get(k)!;
    src.loop = true;
    const merger = ctx.createChannelMerger(2);
    const l = ctx.createGain();
    const r = ctx.createGain();
    l.gain.value = r.gain.value = 0;
    src.connect(l).connect(merger, 0, 0);
    src.connect(r).connect(merger, 0, 1);
    merger.connect(this.bus!);
    src.start();
    return { src, l, r };
  }

  /** "Ear vibration": 48 + 51 Hz (beating) buzzed at 24 Hz, per ear. */
  private makeRumble(ctx: AudioContext): { l: GainNode; r: GainNode } {
    const mix = ctx.createGain();
    for (const f of [48, 51]) {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = f;
      o.connect(mix);
      o.start();
    }
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 160;
    const am = ctx.createGain();
    am.gain.value = 0.5;
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 24;
    const depth = ctx.createGain();
    depth.gain.value = 0.5;
    lfo.connect(depth).connect(am.gain);
    lfo.start();
    mix.connect(lp).connect(am);
    const merger = ctx.createChannelMerger(2);
    const l = ctx.createGain();
    const r = ctx.createGain();
    l.gain.value = r.gain.value = 0;
    am.connect(l).connect(merger, 0, 0);
    am.connect(r).connect(merger, 0, 1);
    merger.connect(this.bus!);
    return { l, r };
  }

  private set(k: SoundName, [lv, rv]: [number, number], rate: number, t: number): void {
    const p = this.loops.get(k);
    if (!p) return;
    p.l.gain.setTargetAtTime(lv, t, 0.06);
    p.r.gain.setTargetAtTime(rv, t, 0.06);
    p.src.playbackRate.setTargetAtTime(rate, t, 0.1);
  }

  /** Call every frame with the control signal (like PG's OnControlSignal). */
  update(ctx: AudioContext, s: GuideSignal, rumbleLevel = 0.5): void {
    if (!this.loaded) return;
    const t = ctx.currentTime;
    const off: [number, number] = [0, 0];
    if (!s.active) {
      for (const k of this.loops.keys()) this.set(k, off, 1, t);
      this.rumble!.l.gain.setTargetAtTime(0, t, 0.08);
      this.rumble!.r.gain.setTargetAtTime(0, t, 0.08);
      return;
    }
    if (s.obstacle) {
      for (const k of ['steering', 'warning', 'turn'] as SoundName[]) this.set(k, off, 1, t);
      this.set('obstacle', [0.8, 0.8], 1, t);
      this.rumble!.l.gain.setTargetAtTime(0, t, 0.08);
      this.rumble!.r.gain.setTargetAtTime(0, t, 0.08);
      return;
    }
    this.set('obstacle', off, 1, t);
    const steer = applyShaping(Math.max(-1, Math.min(1, s.steerDeg / MAX_ROTATION_DEG)));
    const sp = steerPan(steer);
    const sv = lerp(Math.abs(steer), STEER_QUIET, STEER_FULL, 0, 1);
    this.set('steering', [sp[0] * sv, sp[1] * sv], lerp(Math.abs(steer), 0, 1, 1, 1.6, 2), t);
    const warn = applyShaping(Math.max(-1, Math.min(1, s.lateralM / WARNING_M)));
    this.set('warning', warningPan(warn), lerp(Math.abs(warn), WARNING_START, 1, 1, 2, 2), t);
    const turn = applyShaping(Math.max(-1, Math.min(1, s.turnAheadDeg / MAX_ROTATION_DEG)));
    const tv = lerp(Math.abs(turn), TURN_SENSITIVITY, 1, 0, 0.5);
    this.set('turn', [turn < 0 ? tv : 0, turn > 0 ? tv : 0], 1, t);
    // Ear vibration follows the steering side, only once the correction is real.
    const k = lerp(Math.abs(steer), 0.2, 1, 0, rumbleLevel);
    this.rumble!.l.gain.setTargetAtTime(steer < 0 ? k : 0, t, 0.06);
    this.rumble!.r.gain.setTargetAtTime(steer > 0 ? k : 0, t, 0.06);
  }

  /** One-shot sounds (stop, ready). */
  play(ctx: AudioContext, k: 'stop' | 'ready'): boolean {
    const b = this.buffers.get(k);
    if (!b || !this.bus) return false;
    const s = ctx.createBufferSource();
    s.buffer = b;
    s.connect(this.bus);
    s.start();
    return true;
  }
}
