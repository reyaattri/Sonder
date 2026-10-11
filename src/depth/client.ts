import type { DepthIn, DepthOut } from './depth.worker';
import type { DepthMap } from './metric';

/** Talks to the depth worker. One frame in flight at a time; drops frames while busy. */
export class DepthClient {
  backend = '';
  ready = false;
  busy = false;
  lastMs = 0;
  private worker: Worker | null = null;
  private loading: Promise<void> | null = null;
  private nextId = 1;
  private pending = new Map<number, (d: DepthMap | null) => void>();

  constructor(
    private readonly base: string,
    private readonly preferGpu = true,
  ) {}

  load(): Promise<void> {
    if (this.loading) return this.loading;
    this.loading = new Promise<void>((resolve, reject) => {
      const w = new Worker(new URL('./depth.worker.ts', import.meta.url), { type: 'module' });
      this.worker = w;
      w.onmessage = (e: MessageEvent<DepthOut>) => {
        const m = e.data;
        if (m.type === 'ready') {
          this.backend = m.backend;
          this.ready = true;
          resolve();
        } else if (m.type === 'error' && m.id === undefined) {
          this.loading = null;
          reject(new Error(m.message));
        } else if (m.type === 'depth' || m.type === 'error') {
          const cb = this.pending.get(m.id!);
          this.pending.delete(m.id!);
          this.busy = false;
          if (m.type === 'depth') {
            this.lastMs = m.ms;
            cb?.({ data: m.data, width: m.width, height: m.height });
          } else cb?.(null);
        }
      };
      w.onerror = (e) => {
        this.loading = null;
        reject(new Error(e.message || 'depth worker failed'));
      };
      const msg: DepthIn = { type: 'init', base: this.base, preferGpu: this.preferGpu };
      w.postMessage(msg);
    });
    return this.loading;
  }

  /** Takes ownership of `frame`. Resolves null on error. */
  estimate(frame: ImageBitmap): Promise<DepthMap | null> {
    if (!this.worker || !this.ready || this.busy) {
      frame.close();
      return Promise.resolve(null);
    }
    this.busy = true;
    const id = this.nextId++;
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      const msg: DepthIn = { type: 'estimate', id, frame };
      this.worker!.postMessage(msg, [frame]);
    });
  }

  dispose(): void {
    this.worker?.terminate();
    this.worker = null;
    this.loading = null;
    this.ready = false;
    this.busy = false;
  }
}
