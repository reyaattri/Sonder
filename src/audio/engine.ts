import type { AudioMode, SoundStyle } from '../core/types';
import type { CueSource } from '../cues/policy';
import { zonePan } from '../perception/zones';
import {
  createBuzz,
  earcon,
  guidePulse,
  makeNoise,
  personPulse,
  staticPulse,
  vehiclePulse,
  type EarconName,
} from './synth';

/** Hard ceiling on master gain to protect hearing. The volume slider scales below it. */
export const SAFE_MAX_GAIN = 0.6;
/** ~ -12 dB while speech is playing. */
export const DUCK_GAIN = 10 ** (-12 / 20);
const LOOKAHEAD_S = 0.1;
const TICK_MS = 25;
const SMOOTH_S = 0.05;

type Panner = PannerNode | StereoPannerNode;

const MAX_AZ = (80 * Math.PI) / 180;

/** Extra left/right level difference added on top of HRTF (0..1). */
const ILD_BOOST = 0.6;

/** Scale a camera azimuth by `spread`, capped at 80 deg so it never flips behind. */
export function spreadAzimuth(az: number, spread: number): number {
  return Math.max(-MAX_AZ, Math.min(MAX_AZ, az * spread));
}

interface Voice {
  src: CueSource;
  out: GainNode;
  panner: Panner;
  /** Spatial mode extras: extra interaural level difference, and distance darkening. */
  boost?: StereoPannerNode;
  air?: BiquadFilterNode;
  nextPulse: number;
  buzz?: ReturnType<typeof createBuzz>;
  gateOpen: boolean;
}

/**
 * Owns the Web Audio graph:
 *   voices -> cueBus (ducked during speech) -> master (<= SAFE_MAX_GAIN) -> limiter -> out
 *   earcons -> master
 * One voice per cue source, pulsing on a lookahead scheduler so timing stays
 * tight even when the main thread is busy.
 */
export class AudioEngine {
  ctx: AudioContext | null = null;
  mode: AudioMode = 'spatial';
  style: SoundStyle = 'classic';
  /** Spatial-mode direction widening (see Settings.spatialSpread). */
  spread = 2.2;
  private master!: GainNode;
  private cueBus!: GainNode;
  private noise!: AudioBuffer;
  private voices = new Map<string, Voice>();
  /** Persistent spatial chains for lane pings (left and right), built per context. */
  private pingChains: { ctx: AudioContext; left: AudioNode; right: AudioNode } | null = null;
  private timer: number | undefined;
  private volume = 0.8;
  private sinkId = '';

  /** Must be called from a user gesture (iOS starts audio only after a tap). */
  async unlock(): Promise<void> {
    if (!this.ctx) {
      const nav = navigator as Navigator & { audioSession?: { type: string } };
      // iOS 16.4+: play even when the ring/silent switch is on silent.
      if (nav.audioSession) nav.audioSession.type = 'playback';
      const ctx = new AudioContext({ latencyHint: 'interactive' });
      this.ctx = ctx;
      const limiter = ctx.createDynamicsCompressor();
      limiter.threshold.value = -8;
      limiter.knee.value = 0;
      limiter.ratio.value = 20;
      limiter.attack.value = 0.002;
      limiter.release.value = 0.12;
      limiter.connect(ctx.destination);
      this.master = ctx.createGain();
      this.master.connect(limiter);
      this.cueBus = ctx.createGain();
      this.cueBus.connect(this.master);
      this.noise = makeNoise(ctx);
      this.setVolume(this.volume);
      if (this.sinkId) await this.setOutput(this.sinkId).catch(() => {});
      // A silent buffer fully unlocks output on older iOS.
      const b = ctx.createBufferSource();
      b.buffer = ctx.createBuffer(1, 1, 22050);
      b.connect(ctx.destination);
      b.start();
    }
    if (this.ctx.state !== 'running') await this.ctx.resume();
    if (this.timer === undefined) this.timer = window.setInterval(() => this.schedule(), TICK_MS);
  }

  get running(): boolean {
    return this.ctx?.state === 'running';
  }

  /**
   * Channels the current output device can play. 1 means mono: a Bluetooth
   * headset in "hands-free" call mode, or OS mono audio. Spatial cues are
   * impossible until that is fixed.
   */
  get outputChannels(): number {
    return this.ctx?.destination.maxChannelCount ?? 0;
  }

  /** The device id currently selected for output ('' = system default). */
  get outputId(): string {
    return this.sinkId;
  }

  /**
   * Tear down and recreate the audio graph. Browsers can keep playing to the
   * device that was default when audio started (e.g. laptop speakers) after
   * Bluetooth headphones connect; a fresh context binds to the new default.
   */
  async rebuild(): Promise<void> {
    const old = this.ctx;
    for (const [key, v] of this.voices) this.release(key, v);
    this.voices.clear();
    this.ctx = null;
    if (old) await old.close().catch(() => {});
    await this.unlock();
  }

  /** Output path latency in ms (device buffer + hardware), when the browser reports it. */
  get outputLatencyMs(): number {
    if (!this.ctx) return 0;
    return ((this.ctx.outputLatency || 0) + (this.ctx.baseLatency || 0)) * 1000;
  }

  /** Whether the browser can route audio to a chosen device (Chrome/Edge 110+). */
  static get canChooseOutput(): boolean {
    return typeof AudioContext !== 'undefined' && 'setSinkId' in AudioContext.prototype;
  }

  /**
   * Send all sound to a specific output, e.g. Bluetooth headphones.
   * '' = system default. Elsewhere, audio follows the OS's current output.
   */
  async setOutput(deviceId: string): Promise<void> {
    this.sinkId = deviceId;
    const ctx = this.ctx as (AudioContext & { setSinkId?: (id: string) => Promise<void> }) | null;
    if (ctx?.setSinkId) await ctx.setSinkId(deviceId);
  }

  setVolume(v: number): void {
    this.volume = Math.min(1, Math.max(0, v));
    if (this.ctx) this.master.gain.setTargetAtTime(this.volume * SAFE_MAX_GAIN, this.ctx.currentTime, 0.02);
  }

  setMode(mode: AudioMode): void {
    if (mode === this.mode) return;
    this.mode = mode;
    this.silence(); // voices rebuild with the new panner type on the next update
  }

  duck(on: boolean): void {
    if (!this.ctx) return;
    this.cueBus.gain.setTargetAtTime(on ? DUCK_GAIN : 1, this.ctx.currentTime, 0.04);
  }

  /** System sound; `pan` (-1..1) places it to one side (e.g. a fallback warning). */
  earcon(name: EarconName, pan = 0): number {
    if (!this.ctx) return 0;
    let dest: AudioNode = this.master;
    if (pan !== 0) {
      const p = this.ctx.createStereoPanner();
      p.pan.value = pan;
      p.connect(this.master);
      dest = p;
    }
    return earcon(this.ctx, dest, name, this.ctx.currentTime + 0.01);
  }

  /**
   * Track mode: an instant lane ping from one side (pan -1 left, +1 right).
   * A broadband click (localises far better than a pure tone) plus a short
   * tone that rises with intensity, through HRTF + level boost at +/-70 deg.
   * Scheduled at "now" for the lowest possible latency.
   */
  lanePing(pan: number, intensity: number): void {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running') return;
    const dest = this.pingChain(pan < 0 ? 'left' : 'right');
    const t = ctx.currentTime;
    const level = 0.35 + 0.65 * intensity;
    const n = ctx.createBufferSource();
    n.buffer = this.noise;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 3200;
    bp.Q.value = 0.8;
    const ng = ctx.createGain();
    ng.gain.setValueAtTime(0.9 * level, t);
    ng.gain.exponentialRampToValueAtTime(0.0001, t + 0.025);
    n.connect(bp).connect(ng).connect(dest);
    n.start(t);
    n.stop(t + 0.03);
    const o = ctx.createOscillator();
    o.frequency.value = 1300 + 900 * intensity;
    const og = ctx.createGain();
    og.gain.setValueAtTime(0.5 * level, t);
    og.gain.exponentialRampToValueAtTime(0.0001, t + 0.06);
    o.connect(og).connect(dest);
    o.start(t);
    o.stop(t + 0.07);
  }

  private pingChain(side: 'left' | 'right'): AudioNode {
    const ctx = this.ctx!;
    if (!this.pingChains || this.pingChains.ctx !== ctx) {
      const make = (sign: number) => {
        const az = sign * ((70 * Math.PI) / 180);
        const p = ctx.createPanner();
        p.panningModel = 'HRTF';
        p.distanceModel = 'linear';
        p.rolloffFactor = 0;
        if (p.positionX) {
          p.positionX.value = Math.sin(az);
          p.positionZ.value = -Math.cos(az);
        }
        const boost = ctx.createStereoPanner();
        boost.pan.value = sign * 0.75;
        const input = ctx.createGain();
        input.connect(p).connect(boost).connect(this.master);
        return input;
      };
      this.pingChains = { ctx, left: make(-1), right: make(1) };
    }
    return this.pingChains[side];
  }

  /** Play one example of a cue sound, for learning the sound palette. */
  preview(kind: CueSource['kind'], side: 'left' | 'center' | 'right' = 'center', urgency = 0.4): Promise<void> {
    if (!this.ctx) return Promise.resolve();
    const ctx = this.ctx;
    const pan = ctx.createStereoPanner();
    pan.pan.value = side === 'left' ? -1 : side === 'right' ? 1 : 0;
    pan.connect(this.master);
    const t0 = ctx.currentTime + 0.05;
    const period = 0.35;
    const p = { urgency, style: this.style, period, secondTone: urgency > 0.6 };
    for (let i = 0; i < 4; i++) {
      const t = t0 + i * period;
      if (kind === 'person') personPulse(ctx, pan, t, p);
      else if (kind === 'vehicle') vehiclePulse(ctx, pan, t, p);
      else if (kind === 'static') staticPulse(ctx, pan, t, p, this.noise);
      else if (kind === 'guide') guidePulse(ctx, pan, t);
    }
    if (kind === 'blocked') {
      const buzz = createBuzz(ctx, pan);
      for (let i = 0; i < 6; i++) {
        const t = t0 + i * 0.22;
        buzz.gate.gain.setValueAtTime(0, t);
        buzz.gate.gain.linearRampToValueAtTime(1, t + 0.006);
        buzz.gate.gain.setValueAtTime(1, t + 0.12);
        buzz.gate.gain.linearRampToValueAtTime(0, t + 0.13);
      }
      buzz.stop(t0 + 1.4);
    }
    return new Promise((r) => setTimeout(() => {
      pan.disconnect();
      r();
    }, 1600));
  }

  /** Headphone check: a tone hard-panned to one ear. Resolves when it ends. */
  testTone(side: 'left' | 'right'): Promise<void> {
    if (!this.ctx) return Promise.resolve();
    const ctx = this.ctx;
    const t = ctx.currentTime + 0.05;
    const pan = ctx.createStereoPanner();
    pan.pan.value = side === 'left' ? -1 : 1;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.5, t + 0.03);
    g.gain.setValueAtTime(0.5, t + 0.8);
    g.gain.linearRampToValueAtTime(0, t + 0.85);
    const o = ctx.createOscillator();
    o.frequency.value = 600;
    o.connect(g).connect(pan).connect(this.master);
    o.start(t);
    o.stop(t + 0.9);
    return new Promise((r) => {
      o.onended = () => r();
      setTimeout(r, 1500); // never hang if audio is suspended
    });
  }

  /**
   * Spatial check for headphones (wired or Bluetooth): a "person" cue travels
   * from your far left, through straight ahead, to your far right and back.
   * Uses the same HRTF path as live cues in spatial mode.
   */
  spatialTest(durationS = 5): Promise<void> {
    if (!this.ctx) return Promise.resolve();
    const ctx = this.ctx;
    const t0 = ctx.currentTime + 0.1;
    const p = ctx.createPanner();
    p.panningModel = 'HRTF';
    p.distanceModel = 'linear';
    p.rolloffFactor = 0;
    const out = ctx.createGain();
    out.gain.value = 0.8;
    const boost = ctx.createStereoPanner();
    out.connect(p).connect(boost).connect(this.master);
    const steps = 60;
    for (let i = 0; i <= steps; i++) {
      const f = i / steps;
      // -90 deg -> +90 deg -> -90 deg
      const az = (Math.PI / 2) * Math.cos(Math.PI * (1 + 2 * f));
      const t = t0 + f * durationS;
      if (p.positionX) {
        const method = i === 0 ? 'setValueAtTime' : 'linearRampToValueAtTime';
        p.positionX[method](Math.sin(az), t);
        p.positionZ[method](-Math.cos(az), t);
      }
      boost.pan[i === 0 ? 'setValueAtTime' : 'linearRampToValueAtTime'](Math.sin(az) * ILD_BOOST, t);
    }
    for (let t = 0; t < durationS; t += 0.3) {
      personPulse(ctx, out, t0 + t, { urgency: 0.3, style: this.style, period: 0.3 });
    }
    return new Promise((r) =>
      setTimeout(() => {
        out.disconnect();
        p.disconnect();
        boost.disconnect();
        r();
      }, (durationS + 0.4) * 1000),
    );
  }

  /**
   * Sync voices to the current cue sources. Returns, for sources that were
   * just triggered, the audio-clock time their first sound is scheduled at.
   */
  update(sources: CueSource[]): Map<string, number> {
    const started = new Map<string, number>();
    if (!this.ctx) return started;
    const now = this.ctx.currentTime;
    const keep = new Set(sources.map((s) => s.key));
    for (const [key, v] of this.voices) if (!keep.has(key)) this.release(key, v);

    for (const s of sources) {
      let v = this.voices.get(s.key);
      if (!v) {
        v = this.createVoice(s);
        this.voices.set(s.key, v);
      }
      v.src = s;
      this.position(v, false);
      v.out.gain.setTargetAtTime(0.35 + 0.65 * s.urgency, now, SMOOTH_S);
      if (s.triggered && v.nextPulse > now + 0.03) v.nextPulse = now + 0.005;
      if (s.triggered) started.set(s.key, Math.max(v.nextPulse, now));
    }
    this.schedule();
    return started;
  }

  /** Stop every cue voice (pause, stop, mode change). Earcons are unaffected. */
  silence(): void {
    for (const [key, v] of this.voices) this.release(key, v);
  }

  private createVoice(s: CueSource): Voice {
    const ctx = this.ctx!;
    const out = ctx.createGain();
    out.gain.value = 0.35 + 0.65 * s.urgency;
    let panner: Panner;
    if (s.kind === 'blocked' || s.kind === 'guide' || this.mode === 'stereo') {
      panner = ctx.createStereoPanner();
    } else {
      const p = ctx.createPanner();
      p.panningModel = 'HRTF';
      p.distanceModel = 'linear';
      p.rolloffFactor = 0; // loudness is driven by our own distance estimate
      panner = p;
    }
    const v: Voice = { src: s, out, panner, nextPulse: ctx.currentTime + 0.005, gateOpen: false };
    if (panner instanceof PannerNode) {
      // out -> air (distance darkening) -> HRTF -> boost (stronger left/right) -> bus.
      // HRTF alone is subtle on many Bluetooth earbuds; the boost keeps the
      // 3D colour but makes the side unmistakable.
      v.air = ctx.createBiquadFilter();
      v.air.type = 'lowpass';
      v.boost = ctx.createStereoPanner();
      out.connect(v.air).connect(panner).connect(v.boost).connect(this.cueBus);
    } else {
      out.connect(panner).connect(this.cueBus);
    }
    if (s.kind === 'blocked') v.buzz = createBuzz(ctx, out);
    this.position(v, true);
    return v;
  }

  private position(v: Voice, immediate: boolean): void {
    const ctx = this.ctx!;
    const s = v.src;
    const t = ctx.currentTime;
    const set = (param: AudioParam, value: number) =>
      immediate ? param.setValueAtTime(value, t) : param.setTargetAtTime(value, t, SMOOTH_S);
    if (v.panner instanceof StereoPannerNode) {
      const pan = s.kind === 'guide' ? (s.zone === 'left' ? -1 : 1) : s.kind === 'blocked' ? 0 : zonePan(s.zone);
      set(v.panner.pan, pan);
      return;
    }
    // Unit circle around the listener; -z is straight ahead. Widen the
    // camera's narrow field of view so left/right is unmistakable.
    const az = spreadAzimuth(s.azimuth, this.spread);
    const x = Math.sin(az);
    const z = -Math.cos(az);
    const p = v.panner;
    if (p.positionX) {
      set(p.positionX, x);
      set(p.positionY, 0);
      set(p.positionZ, z);
    } else {
      (p as unknown as { setPosition(x: number, y: number, z: number): void }).setPosition(x, 0, z);
    }
    if (v.boost) set(v.boost.pan, Math.sin(az) * ILD_BOOST);
    // Air absorption: far sounds are duller, near ones bright (another distance cue).
    if (v.air) set(v.air.frequency, 3500 + 14000 * s.urgency);
  }

  private schedule(): void {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running') return;
    const now = ctx.currentTime;
    for (const v of this.voices.values()) {
      const s = v.src;
      if (v.buzz && s.continuous) {
        if (!v.gateOpen) {
          v.buzz.gate.gain.cancelScheduledValues(now);
          v.buzz.gate.gain.setTargetAtTime(1, now, 0.01);
          v.gateOpen = true;
        }
        v.nextPulse = now + 0.05;
        continue;
      }
      if (v.buzz && v.gateOpen) {
        v.buzz.gate.gain.cancelScheduledValues(now);
        v.buzz.gate.gain.setTargetAtTime(0, now, 0.01);
        v.gateOpen = false;
      }
      if (v.nextPulse < now) v.nextPulse = now + 0.005;
      const period = 1 / Math.max(0.2, s.rateHz);
      while (v.nextPulse < now + LOOKAHEAD_S) {
        this.pulse(v, v.nextPulse, period);
        v.nextPulse += period;
      }
    }
  }

  private pulse(v: Voice, t: number, period: number): void {
    const ctx = this.ctx!;
    const s = v.src;
    const p = { urgency: s.urgency, style: this.style, secondTone: s.secondTone, period };
    switch (s.kind) {
      case 'person':
        return personPulse(ctx, v.out, t, p);
      case 'vehicle':
        return vehiclePulse(ctx, v.out, t, p);
      case 'static':
        return staticPulse(ctx, v.out, t, p, this.noise);
      case 'guide':
        return guidePulse(ctx, v.out, t);
      case 'blocked': {
        const g = v.buzz!.gate.gain;
        const on = Math.min(0.14, period * 0.5);
        g.setValueAtTime(0, t);
        g.linearRampToValueAtTime(1, t + 0.006);
        g.setValueAtTime(1, t + on);
        g.linearRampToValueAtTime(0, t + on + 0.01);
        return;
      }
    }
  }

  private release(key: string, v: Voice): void {
    this.voices.delete(key);
    const ctx = this.ctx!;
    const t = ctx.currentTime;
    v.out.gain.cancelScheduledValues(t);
    v.out.gain.setTargetAtTime(0, t, 0.03);
    v.buzz?.stop(t + 0.3);
    setTimeout(() => {
      v.out.disconnect();
      v.panner.disconnect();
      v.boost?.disconnect();
      v.air?.disconnect();
    }, 600);
  }
}
