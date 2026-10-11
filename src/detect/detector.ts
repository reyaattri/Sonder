import type { Detection, ModelId } from '../core/types';

/** Anything a detector can read pixels from. */
export type Frame = ImageBitmap | OffscreenCanvas | HTMLCanvasElement | HTMLVideoElement;

/**
 * The single swappable detector contract (US-4.4): a frame in, normalized
 * boxes + class labels + scores out. Adding a model means adding one class.
 */
export interface Detector {
  readonly model: ModelId;
  /** Which compute backend ended up in use, e.g. "GPU", "CPU", "webgpu", "wasm". */
  readonly backend: string;
  init(): Promise<void>;
  /** `timestampMs` must increase monotonically (MediaPipe VIDEO mode requires it). */
  detect(frame: Frame, timestampMs: number): Promise<Detection[]>;
  dispose(): void;
}

export interface ModelSpec {
  id: ModelId;
  title: string;
  file: string;
  runtime: 'mediapipe' | 'onnx';
  licence: string;
}

export const MODELS: Record<ModelId, ModelSpec> = {
  efficientdet_lite0: {
    id: 'efficientdet_lite0',
    title: 'Fast (EfficientDet-Lite0)',
    file: 'models/efficientdet_lite0.tflite',
    runtime: 'mediapipe',
    licence: 'Apache-2.0',
  },
  efficientdet_lite2: {
    id: 'efficientdet_lite2',
    title: 'Accurate (EfficientDet-Lite2)',
    file: 'models/efficientdet_lite2.tflite',
    runtime: 'mediapipe',
    licence: 'Apache-2.0',
  },
  yolox_nano: {
    id: 'yolox_nano',
    title: 'YOLOX-nano (ONNX Runtime)',
    file: 'models/yolox_nano.onnx',
    runtime: 'onnx',
    licence: 'Apache-2.0',
  },
};

/** Detector score floor; the sensitivity setting filters further downstream. */
export const BASE_SCORE_THRESHOLD = 0.3;
export const MAX_RESULTS = 12;

/** Absolute URL for a file in /public, resolved against the app's base. */
export function assetUrl(path: string, base: string): string {
  return new URL(path, base).href;
}
