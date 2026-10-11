/// <reference lib="webworker" />
import type { InferenceSession, Tensor } from 'onnxruntime-web';

/**
 * Monocular depth (Depth Anything V2 Small, Apache-2.0) in its own worker.
 * WebGPU + fp16 model when the GPU supports it, else the int8 model on WASM.
 * Input: an ImageBitmap. Output: relative inverse depth ("disparity"), same
 * aspect, longest side ~252 px (multiple of 14, as the model requires).
 */
export type DepthIn =
  | { type: 'init'; base: string; preferGpu: boolean }
  | { type: 'estimate'; id: number; frame: ImageBitmap };

export type DepthOut =
  | { type: 'ready'; backend: string }
  | { type: 'depth'; id: number; data: Float32Array; width: number; height: number; ms: number }
  | { type: 'error'; id?: number; message: string };

const LONG = 252;
const MEAN = [0.485, 0.456, 0.406];
const STD = [0.229, 0.224, 0.225];

let ort: typeof import('onnxruntime-web') | null = null;
let session: InferenceSession | null = null;
let canvas: OffscreenCanvas | null = null;
const post = (m: DepthOut, transfer: Transferable[] = []) =>
  (self as unknown as DedicatedWorkerGlobalScope).postMessage(m, transfer);

async function init(base: string, preferGpu: boolean): Promise<string> {
  ort = await import('onnxruntime-web');
  ort.env.wasm.wasmPaths = new URL('vendor/ort/', base).href;
  ort.env.wasm.numThreads = (self as { crossOriginIsolated?: boolean }).crossOriginIsolated ? 0 : 1;
  const nav = navigator as Navigator & { gpu?: { requestAdapter(): Promise<{ features: Set<string> } | null> } };
  let f16 = false;
  if (preferGpu && nav.gpu) {
    const adapter = await nav.gpu.requestAdapter().catch(() => null);
    f16 = !!adapter?.features.has('shader-f16');
  }
  const attempts: [string, string][] = f16
    ? [
        ['models/depth_anything_v2_small_fp16.onnx', 'webgpu'],
        ['models/depth_anything_v2_small_q8.onnx', 'wasm'],
      ]
    : [['models/depth_anything_v2_small_q8.onnx', 'wasm']];
  let last: unknown;
  for (const [file, ep] of attempts) {
    try {
      const bytes = await (await fetch(new URL(file, base))).arrayBuffer();
      session = await ort.InferenceSession.create(bytes, { executionProviders: [ep], graphOptimizationLevel: 'all' });
      return ep === 'webgpu' ? 'webgpu (fp16)' : 'wasm (int8)';
    } catch (e) {
      last = e;
    }
  }
  throw last;
}

async function estimate(frame: ImageBitmap): Promise<{ data: Float32Array; width: number; height: number }> {
  if (!ort || !session) throw new Error('depth model not loaded');
  const s = LONG / Math.max(frame.width, frame.height);
  const w = Math.max(14, Math.round((frame.width * s) / 14) * 14);
  const h = Math.max(14, Math.round((frame.height * s) / 14) * 14);
  if (!canvas || canvas.width !== w || canvas.height !== h) canvas = new OffscreenCanvas(w, h);
  const g = canvas.getContext('2d', { willReadFrequently: true })!;
  g.drawImage(frame, 0, 0, w, h);
  const px = g.getImageData(0, 0, w, h).data;
  const plane = w * h;
  const input = new Float32Array(3 * plane);
  for (let i = 0; i < plane; i++)
    for (let c = 0; c < 3; c++) input[c * plane + i] = (px[i * 4 + c] / 255 - MEAN[c]) / STD[c];
  const feeds: Record<string, Tensor> = { [session.inputNames[0]]: new ort.Tensor('float32', input, [1, 3, h, w]) };
  const out = await session.run(feeds);
  const t = out[session.outputNames[0]];
  let data = t.data as Float32Array | Uint16Array;
  if (!(data instanceof Float32Array)) data = Float32Array.from(data as unknown as ArrayLike<number>);
  const dims = t.dims;
  return { data: data as Float32Array, width: dims[dims.length - 1], height: dims[dims.length - 2] };
}

self.onmessage = async (e: MessageEvent<DepthIn>) => {
  const m = e.data;
  if (m.type === 'init') {
    try {
      const backend = await init(m.base, m.preferGpu);
      // Warm-up so the first live frame isn't slow (shader compilation).
      const blank = new OffscreenCanvas(196, 252);
      blank.getContext('2d')!.fillRect(0, 0, 196, 252);
      await estimate(blank.transferToImageBitmap());
      post({ type: 'ready', backend });
    } catch (err) {
      post({ type: 'error', message: String((err as Error)?.message ?? err) });
    }
    return;
  }
  try {
    const t0 = performance.now();
    const r = await estimate(m.frame);
    post({ type: 'depth', id: m.id, ...r, ms: performance.now() - t0 }, [r.data.buffer]);
  } catch (err) {
    post({ type: 'error', id: m.id, message: String((err as Error)?.message ?? err) });
  } finally {
    m.frame.close();
  }
};
