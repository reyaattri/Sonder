/// <reference lib="webworker" />
import type { Detection, ModelId } from '../core/types';
import type { Detector } from './detector';
import { createDetector } from './factory';

/** Messages: main -> worker */
export type WorkerIn =
  | { type: 'init'; model: ModelId; base: string; preferGpu: boolean }
  | { type: 'detect'; id: number; frame: ImageBitmap; ts: number };

/** Messages: worker -> main */
export type WorkerOut =
  | { type: 'ready'; backend: string }
  | { type: 'result'; id: number; detections: Detection[]; inferenceMs: number }
  | { type: 'error'; id?: number; message: string };

let detector: Detector | null = null;
const post = (m: WorkerOut) => (self as unknown as DedicatedWorkerGlobalScope).postMessage(m);

self.onmessage = async (e: MessageEvent<WorkerIn>) => {
  const msg = e.data;
  if (msg.type === 'init') {
    try {
      detector?.dispose();
      detector = await createDetector(msg.model, msg.base, msg.preferGpu);
      await detector.init();
      // The first inference compiles GPU shaders and can take seconds; do it
      // now, during loading, so live frames never stall on it.
      const blank = new OffscreenCanvas(320, 240);
      blank.getContext('2d')!.fillRect(0, 0, 320, 240);
      await detector.detect(blank.transferToImageBitmap(), 0);
      post({ type: 'ready', backend: detector.backend });
    } catch (err) {
      post({ type: 'error', message: String((err as Error)?.message ?? err) });
    }
    return;
  }
  if (msg.type === 'detect') {
    try {
      if (!detector) throw new Error('not initialised');
      const t0 = performance.now();
      const detections = await detector.detect(msg.frame, msg.ts);
      post({ type: 'result', id: msg.id, detections, inferenceMs: performance.now() - t0 });
    } catch (err) {
      post({ type: 'error', id: msg.id, message: String((err as Error)?.message ?? err) });
    } finally {
      msg.frame.close();
    }
  }
};
