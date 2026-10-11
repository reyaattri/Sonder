import type { Detection } from '../core/types';
import { COCO80 } from '../perception/classes';
import { iou } from '../perception/geometry';
import { assetUrl, BASE_SCORE_THRESHOLD, MAX_RESULTS, MODELS, type Detector, type Frame } from './detector';

export const YOLOX_INPUT = 416;
const STRIDES = [8, 16, 32];
const NUM_CLASSES = 80;

/** Grid cell (gx, gy) and stride for every anchor row of the raw YOLOX output. */
export function yoloxGrid(input = YOLOX_INPUT): { gx: Int32Array; gy: Int32Array; stride: Int32Array } {
  const n = STRIDES.reduce((s, st) => s + (input / st) ** 2, 0);
  const gx = new Int32Array(n), gy = new Int32Array(n), stride = new Int32Array(n);
  let i = 0;
  for (const st of STRIDES) {
    const g = input / st;
    for (let y = 0; y < g; y++)
      for (let x = 0; x < g; x++, i++) {
        gx[i] = x;
        gy[i] = y;
        stride[i] = st;
      }
  }
  return { gx, gy, stride };
}

/** Class-aware greedy non-maximum suppression. */
export function nms(dets: Detection[], iouThreshold = 0.45): Detection[] {
  const sorted = [...dets].sort((a, b) => b.score - a.score);
  const keep: Detection[] = [];
  for (const d of sorted) {
    if (keep.some((k) => k.label === d.label && iou(k.box, d.box) > iouThreshold)) continue;
    keep.push(d);
  }
  return keep;
}

/**
 * Decode the raw [1, N, 85] YOLOX output (box regressions + sigmoid
 * objectness + sigmoid class scores) into normalized source-frame boxes.
 * `ratio` is the letterbox scale used when resizing the source to the input.
 */
export function decodeYolox(
  out: Float32Array,
  srcW: number,
  srcH: number,
  ratio: number,
  threshold = BASE_SCORE_THRESHOLD,
  grid = yoloxGrid(),
): Detection[] {
  const stride = 5 + NUM_CLASSES;
  const n = out.length / stride;
  const dets: Detection[] = [];
  for (let i = 0; i < n; i++) {
    const o = i * stride;
    const obj = out[o + 4];
    if (obj < threshold) continue;
    let best = 0, bestScore = 0;
    for (let c = 0; c < NUM_CLASSES; c++) {
      const s = out[o + 5 + c];
      if (s > bestScore) {
        bestScore = s;
        best = c;
      }
    }
    const score = obj * bestScore;
    if (score < threshold) continue;
    const st = grid.stride[i];
    const cx = (out[o] + grid.gx[i]) * st;
    const cy = (out[o + 1] + grid.gy[i]) * st;
    const w = Math.exp(out[o + 2]) * st;
    const h = Math.exp(out[o + 3]) * st;
    // Back to source pixels (undo the letterbox scale), then normalize.
    const x0 = Math.max(0, (cx - w / 2) / ratio);
    const y0 = Math.max(0, (cy - h / 2) / ratio);
    const x1 = Math.min(srcW, (cx + w / 2) / ratio);
    const y1 = Math.min(srcH, (cy + h / 2) / ratio);
    if (x1 <= x0 || y1 <= y0) continue;
    dets.push({
      label: COCO80[best],
      score,
      box: { x: x0 / srcW, y: y0 / srcH, w: (x1 - x0) / srcW, h: (y1 - y0) / srcH },
    });
  }
  return nms(dets).slice(0, MAX_RESULTS);
}

type Ort = typeof import('onnxruntime-web');

/** YOLOX-nano (Apache-2.0) on ONNX Runtime Web: WebGPU when available, WASM otherwise. */
export class YoloxDetector implements Detector {
  readonly model = 'yolox_nano' as const;
  backend = 'pending';
  private ort: Ort | null = null;
  private session: import('onnxruntime-web').InferenceSession | null = null;
  private canvas: OffscreenCanvas | HTMLCanvasElement | null = null;
  private grid = yoloxGrid();
  private input = new Float32Array(3 * YOLOX_INPUT * YOLOX_INPUT);

  constructor(private readonly base: string) {}

  async init(): Promise<void> {
    const ort = await import('onnxruntime-web');
    this.ort = ort;
    ort.env.wasm.wasmPaths = assetUrl('vendor/ort/', this.base);
    // Threads need cross-origin isolation, which a static host may not give us.
    ort.env.wasm.numThreads = (self as { crossOriginIsolated?: boolean }).crossOriginIsolated ? 0 : 1;
    const model = await (await fetch(assetUrl(MODELS.yolox_nano.file, this.base))).arrayBuffer();
    const providers = 'gpu' in navigator ? ['webgpu', 'wasm'] : ['wasm'];
    for (const ep of providers) {
      try {
        this.session = await ort.InferenceSession.create(model, { executionProviders: [ep] });
        this.backend = ep;
        break;
      } catch (e) {
        if (ep === 'wasm') throw e;
      }
    }
    this.canvas =
      typeof OffscreenCanvas !== 'undefined'
        ? new OffscreenCanvas(YOLOX_INPUT, YOLOX_INPUT)
        : Object.assign(document.createElement('canvas'), { width: YOLOX_INPUT, height: YOLOX_INPUT });
  }

  async detect(frame: Frame): Promise<Detection[]> {
    if (!this.session || !this.ort || !this.canvas) throw new Error('Detector not initialised');
    const srcW = 'videoWidth' in frame ? frame.videoWidth : frame.width;
    const srcH = 'videoHeight' in frame ? frame.videoHeight : frame.height;
    const ratio = Math.min(YOLOX_INPUT / srcW, YOLOX_INPUT / srcH);
    const ctx = this.canvas.getContext('2d', { willReadFrequently: true }) as
      | OffscreenCanvasRenderingContext2D
      | CanvasRenderingContext2D;
    ctx.fillStyle = 'rgb(114,114,114)';
    ctx.fillRect(0, 0, YOLOX_INPUT, YOLOX_INPUT);
    ctx.drawImage(frame, 0, 0, srcW * ratio, srcH * ratio);
    const px = ctx.getImageData(0, 0, YOLOX_INPUT, YOLOX_INPUT).data;
    // CHW, BGR order, raw 0..255 (YOLOX >= 0.1.1 expects no normalization).
    const plane = YOLOX_INPUT * YOLOX_INPUT;
    for (let i = 0; i < plane; i++) {
      this.input[i] = px[i * 4 + 2];
      this.input[plane + i] = px[i * 4 + 1];
      this.input[2 * plane + i] = px[i * 4];
    }
    const tensor = new this.ort.Tensor('float32', this.input, [1, 3, YOLOX_INPUT, YOLOX_INPUT]);
    const feeds = { [this.session.inputNames[0]]: tensor };
    const result = await this.session.run(feeds);
    const out = result[this.session.outputNames[0]].data as Float32Array;
    return decodeYolox(out, srcW, srcH, ratio, BASE_SCORE_THRESHOLD, this.grid);
  }

  dispose(): void {
    void this.session?.release();
    this.session = null;
  }
}
