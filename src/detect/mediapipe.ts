import { FilesetResolver, ObjectDetector } from '@mediapipe/tasks-vision';
import type { Detection, ModelId } from '../core/types';
import { assetUrl, BASE_SCORE_THRESHOLD, MAX_RESULTS, MODELS, type Detector, type Frame } from './detector';

/**
 * MediaPipe's loader uses importScripts() inside workers, which module
 * workers forbid. Pre-fetch the loader script and evaluate it in global
 * scope instead, so the same code runs in module workers and on the page.
 */
async function patchImportScripts(loaderUrl: string): Promise<void> {
  const g = self as unknown as { importScripts?: (u: string) => void; document?: unknown };
  if (typeof g.document !== 'undefined') return; // main thread: MediaPipe uses a <script> tag
  const src = await (await fetch(loaderUrl)).text();
  g.importScripts = () => {
    (0, eval)(src);
  };
}

export class MediaPipeDetector implements Detector {
  backend = 'pending';
  private det: ObjectDetector | null = null;
  private lastTs = 0;

  constructor(
    readonly model: ModelId,
    private readonly base: string,
    private readonly preferGpu = true,
  ) {}

  async init(): Promise<void> {
    const simd = await FilesetResolver.isSimdSupported();
    const name = simd ? 'vision_wasm_internal' : 'vision_wasm_nosimd_internal';
    const wasmLoaderPath = assetUrl(`vendor/mediapipe/${name}.js`, this.base);
    const wasmBinaryPath = assetUrl(`vendor/mediapipe/${name}.wasm`, this.base);
    await patchImportScripts(wasmLoaderPath);
    const fileset = { wasmLoaderPath, wasmBinaryPath };
    const modelAssetPath = assetUrl(MODELS[this.model].file, this.base);

    const delegates: ('GPU' | 'CPU')[] = this.preferGpu ? ['GPU', 'CPU'] : ['CPU'];
    let lastErr: unknown;
    for (const delegate of delegates) {
      try {
        this.det = await ObjectDetector.createFromOptions(fileset, {
          baseOptions: { modelAssetPath, delegate },
          runningMode: 'VIDEO',
          scoreThreshold: BASE_SCORE_THRESHOLD,
          maxResults: MAX_RESULTS,
        });
        this.backend = delegate;
        return;
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr;
  }

  async detect(frame: Frame, timestampMs: number): Promise<Detection[]> {
    if (!this.det) throw new Error('Detector not initialised');
    const ts = Math.max(timestampMs, this.lastTs + 1);
    this.lastTs = ts;
    const w = 'videoWidth' in frame ? frame.videoWidth : frame.width;
    const h = 'videoHeight' in frame ? frame.videoHeight : frame.height;
    const res = this.det.detectForVideo(frame, ts);
    return res.detections.flatMap((d) => {
      const bb = d.boundingBox;
      const c = d.categories[0];
      if (!bb || !c) return [];
      return [
        {
          label: c.categoryName,
          score: c.score,
          box: { x: bb.originX / w, y: bb.originY / h, w: bb.width / w, h: bb.height / h },
        },
      ];
    });
  }

  dispose(): void {
    this.det?.close();
    this.det = null;
  }
}

