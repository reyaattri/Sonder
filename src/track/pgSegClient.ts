import type { MaskKeypoint } from './pgKeypoints';
import type { SegIn, SegOut } from './pgSeg.worker';

/** Runs Project Guideline's segmentation model in a worker; one frame in flight. */
export class PgSegClient {
  ready = false;
  busy = false;
  lastMs = 0;
  /** Which delegate passed the self-test on Google's photo. */
  delegate: 'GPU' | 'CPU' | '' = '';
  latest: { keypoints: MaskKeypoint[]; at: number } | null = null;
  private worker: Worker | null = null;
  private loading: Promise<void> | null = null;
  private id = 1;

  constructor(private readonly base: string) {}

  load(): Promise<void> {
    if (this.loading) return this.loading;
    this.loading = new Promise((resolve, reject) => {
      const w = new Worker(new URL('./pgSeg.worker.ts', import.meta.url), { type: 'module' });
      this.worker = w;
      w.onmessage = (e: MessageEvent<SegOut>) => {
        const m = e.data;
        if (m.type === 'ready') {
          this.ready = true;
          this.delegate = m.delegate;
          resolve();
        } else if (m.type === 'keypoints') {
          this.busy = false;
          this.lastMs = m.ms;
          this.latest = { keypoints: m.keypoints, at: performance.now() };
        } else if (m.type === 'error') {
          this.busy = false;
          if (m.id === undefined) {
            this.loading = null;
            reject(new Error(m.message));
          }
        }
      };
      const msg: SegIn = { type: 'init', base: this.base };
      w.postMessage(msg);
    });
    return this.loading;
  }

  /** Fire and forget; results arrive in `latest`. Takes ownership of the frame. */
  submit(frame: ImageBitmap): void {
    if (!this.worker || !this.ready || this.busy) {
      frame.close();
      return;
    }
    this.busy = true;
    const msg: SegIn = { type: 'segment', id: this.id++, frame };
    this.worker.postMessage(msg, [frame]);
  }

  dispose(): void {
    this.worker?.terminate();
    this.worker = null;
    this.loading = null;
    this.ready = false;
  }
}
