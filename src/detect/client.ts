import type { Detection, ModelId } from '../core/types';
import type { Detector } from './detector';
import type { WorkerIn, WorkerOut } from './detect.worker';
import { createDetector } from './factory';

export interface DetectOutput {
  detections: Detection[];
  inferenceMs: number;
}

const DETECT_TIMEOUT_MS = 5000;

/**
 * Runs the detector in a Web Worker so inference never blocks audio
 * scheduling or the UI. If the worker can't start the model (old browser,
 * no OffscreenCanvas), falls back to running on the main thread.
 */
export class DetectionClient {
  model: ModelId | null = null;
  backend = '';
  where: 'worker' | 'main' = 'worker';
  private worker: Worker | null = null;
  private local: Detector | null = null;
  private nextId = 1;
  private pending = new Map<number, { resolve: (o: DetectOutput) => void; reject: (e: Error) => void; timer: number }>();

  /**
   * `preferGpu: false` keeps inference on the CPU (WASM) so it never competes
   * with the GPU for camera frames, e.g. track mode's 60 fps lane guide.
   */
  constructor(
    private readonly base: string,
    private readonly preferGpu = true,
  ) {}

  async load(model: ModelId): Promise<void> {
    this.dispose();
    this.model = model;
    try {
      await this.startWorker(model);
      this.where = 'worker';
    } catch (err) {
      console.warn('[EchoPath] worker detector failed, using main thread:', err);
      this.dispose();
      this.model = model;
      try {
        this.local = await createDetector(model, this.base, this.preferGpu);
        await this.local.init();
      } catch (e2) {
        this.local = null;
        this.model = null; // so a retry actually reloads
        throw e2;
      }
      const blank = Object.assign(document.createElement('canvas'), { width: 320, height: 240 });
      blank.getContext('2d')!.fillRect(0, 0, 320, 240);
      await this.local.detect(blank, 0); // warm-up: compile shaders before live frames
      this.backend = this.local.backend;
      this.where = 'main';
    }
  }

  /** Takes ownership of `frame` (it is transferred or closed). */
  async detect(frame: ImageBitmap, ts: number): Promise<DetectOutput> {
    if (this.local) {
      const t0 = performance.now();
      try {
        const detections = await this.local.detect(frame, ts);
        return { detections, inferenceMs: performance.now() - t0 };
      } finally {
        frame.close();
      }
    }
    const worker = this.worker;
    if (!worker) {
      frame.close();
      throw new Error('Detector not loaded');
    }
    const id = this.nextId++;
    return new Promise<DetectOutput>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('Detection timed out'));
      }, DETECT_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      const msg: WorkerIn = { type: 'detect', id, frame, ts };
      worker.postMessage(msg, [frame]);
    });
  }

  dispose(): void {
    this.worker?.terminate();
    this.worker = null;
    this.local?.dispose();
    this.local = null;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error('Detector disposed'));
    }
    this.pending.clear();
  }

  private startWorker(model: ModelId): Promise<void> {
    const worker = new Worker(new URL('./detect.worker.ts', import.meta.url), { type: 'module' });
    this.worker = worker;
    return new Promise<void>((resolve, reject) => {
      worker.onerror = (e) => reject(new Error(e.message || 'worker failed to start'));
      worker.onmessage = (e: MessageEvent<WorkerOut>) => {
        const m = e.data;
        if (m.type === 'ready') {
          this.backend = m.backend;
          worker.onmessage = (ev: MessageEvent<WorkerOut>) => this.onResult(ev.data);
          resolve();
        } else if (m.type === 'error') {
          reject(new Error(m.message));
        }
      };
      const msg: WorkerIn = { type: 'init', model, base: this.base, preferGpu: this.preferGpu };
      worker.postMessage(msg);
    });
  }

  private onResult(m: WorkerOut): void {
    if (m.type === 'ready' || m.id === undefined) return;
    const p = this.pending.get(m.id);
    if (!p) return;
    this.pending.delete(m.id);
    clearTimeout(p.timer);
    if (m.type === 'result') p.resolve({ detections: m.detections, inferenceMs: m.inferenceMs });
    else p.reject(new Error(m.message));
  }
}
