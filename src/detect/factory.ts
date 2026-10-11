import type { ModelId } from '../core/types';
import { MODELS, type Detector } from './detector';

/** Builds the detector for a model id. Heavy runtimes are imported lazily. */
export async function createDetector(model: ModelId, base: string, preferGpu = true): Promise<Detector> {
  if (MODELS[model].runtime === 'onnx') {
    const { YoloxDetector } = await import('./yolox');
    return new YoloxDetector(base);
  }
  const { MediaPipeDetector } = await import('./mediapipe');
  return new MediaPipeDetector(model, base, preferGpu);
}
