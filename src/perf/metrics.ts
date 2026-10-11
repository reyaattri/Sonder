/** Fixed-size rolling sample buffer with percentile queries. */
export class Rolling {
  private buf: number[] = [];
  constructor(private readonly size: number) {}

  push(v: number): void {
    this.buf.push(v);
    if (this.buf.length > this.size) this.buf.shift();
  }

  get count(): number {
    return this.buf.length;
  }

  percentile(p: number): number {
    if (!this.buf.length) return NaN;
    const s = [...this.buf].sort((a, b) => a - b);
    const i = Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1));
    return s[i];
  }

  clear(): void {
    this.buf = [];
  }
}

/** Processed frames per second over a sliding time window. */
export class FpsMeter {
  private stamps: number[] = [];
  constructor(private readonly windowMs = 2000) {}

  tick(now: number): void {
    this.stamps.push(now);
    while (this.stamps.length && now - this.stamps[0] > this.windowMs) this.stamps.shift();
  }

  fps(now: number): number {
    const recent = this.stamps.filter((t) => now - t <= this.windowMs);
    if (recent.length < 2) return 0;
    return ((recent.length - 1) * 1000) / (recent[recent.length - 1] - recent[0] || 1);
  }

  clear(): void {
    this.stamps = [];
  }
}

export class Metrics {
  readonly fps = new FpsMeter();
  readonly inferenceMs = new Rolling(120);
  /** Capture -> decision (every frame). */
  readonly pipelineMs = new Rolling(120);
  /** Capture -> sound reaching the output (frames that started a cue). */
  readonly captureToSoundMs = new Rolling(200);

  snapshot(now: number) {
    return {
      fps: this.fps.fps(now),
      inferenceP50: this.inferenceMs.percentile(50),
      pipelineP95: this.pipelineMs.percentile(95),
      latencyP50: this.captureToSoundMs.percentile(50),
      latencyP95: this.captureToSoundMs.percentile(95),
      latencySamples: this.captureToSoundMs.count,
    };
  }
}
