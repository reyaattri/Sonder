/// <reference lib="webworker" />
import { FilesetResolver, ImageSegmenter } from '@mediapipe/tasks-vision';
import { patchImportScripts } from '../detect/mediapipe';
import { blockKeypoints, type MaskKeypoint } from './pgKeypoints';

/**
 * Google Project Guideline's guideline segmentation model (DeepLab-style,
 * 513x513, trained on a purple painted line) via MediaPipe ImageSegmenter -
 * exactly how Project Guideline runs it - in its own worker.
 * Their phones are in landscape, so frames are rotated a quarter turn in
 * before segmenting and keypoints are rotated back out.
 */
export type SegIn = { type: 'init'; base: string } | { type: 'segment'; id: number; frame: ImageBitmap };
export type SegOut =
  | { type: 'ready'; delegate: 'GPU' | 'CPU' }
  | { type: 'keypoints'; id: number; keypoints: MaskKeypoint[]; ms: number }
  | { type: 'error'; id?: number; message: string };

let seg: ImageSegmenter | null = null;
let delegateUsed: 'GPU' | 'CPU' = 'CPU';

/** On guideline1.png, Google's labelled line crosses 60% height at about 37% across. */
function selfTest(s: ImageSegmenter, img: ImageBitmap): boolean {
  const c = new OffscreenCanvas(img.width, img.height);
  c.getContext('2d')!.drawImage(img, 0, 0);
  const r = s.segment(c);
  const m = r.confidenceMasks?.[1];
  let ok = false;
  if (m) {
    const d = m.getAsFloat32Array();
    const y = Math.floor(m.height * 0.6);
    let sx = 0, n = 0;
    for (let x = 0; x < m.width; x++) if (d[y * m.width + x] > 0.5) (sx += x), n++;
    ok = n > 3 && Math.abs(sx / n / m.width - 0.37) < 0.06;
  }
  r.confidenceMasks?.forEach((cm) => cm.close());
  return ok;
}
let canvas: OffscreenCanvas | null = null;
const post = (m: SegOut) => (self as unknown as DedicatedWorkerGlobalScope).postMessage(m);

self.onmessage = async (e: MessageEvent<SegIn>) => {
  const m = e.data;
  if (m.type === 'init') {
    try {
      const simd = await FilesetResolver.isSimdSupported();
      const name = simd ? 'vision_wasm_internal' : 'vision_wasm_nosimd_internal';
      const wasmLoaderPath = new URL(`vendor/mediapipe/${name}.js`, m.base).href;
      await patchImportScripts(wasmLoaderPath);
      const fileset = { wasmLoaderPath, wasmBinaryPath: new URL(`vendor/mediapipe/${name}.wasm`, m.base).href };
      const modelAssetPath = new URL('models/pg_guideline.tflite', m.base).href;
      // Some browsers' GPU delegate runs this model but returns garbage masks
      // (seen on Windows/Chrome). So the GPU must prove itself on Google's own
      // real test photo - find the line where Google's labels say it is -
      // before we trust it. Otherwise: CPU, which matches Google's results.
      const sample = await fetch(new URL('samples/pg/guideline1.png', m.base).href)
        .then((r) => (r.ok ? r.blob() : null))
        .then((b) => (b ? createImageBitmap(b) : null))
        .catch(() => null);
      for (const delegate of ['GPU', 'CPU'] as const) {
        try {
          const s = await ImageSegmenter.createFromOptions(fileset, {
            baseOptions: { modelAssetPath, delegate },
            runningMode: 'IMAGE',
            outputConfidenceMasks: true,
            outputCategoryMask: false,
          });
          if (delegate === 'GPU' && !(sample && selfTest(s, sample))) {
            s.close();
            continue;
          }
          seg = s;
          delegateUsed = delegate;
          break;
        } catch (err) {
          if (delegate === 'CPU') throw err;
        }
      }
      sample?.close();
      post({ type: 'ready', delegate: delegateUsed });
    } catch (err) {
      post({ type: 'error', message: String((err as Error)?.message ?? err) });
    }
    return;
  }
  try {
    if (!seg) throw new Error('segmenter not ready');
    const t0 = performance.now();
    const fw = m.frame.width, fh = m.frame.height;
    const portrait = fh > fw;
    // Rotate a quarter turn (portrait camera -> the landscape view the model knows).
    const cw = portrait ? fh : fw, ch = portrait ? fw : fh;
    if (!canvas || canvas.width !== cw || canvas.height !== ch) canvas = new OffscreenCanvas(cw, ch);
    const g = canvas.getContext('2d')!;
    if (portrait) g.setTransform(0, -1, 1, 0, 0, fw);
    else g.setTransform(1, 0, 0, 1, 0, 0);
    g.drawImage(m.frame, 0, 0);
    const r = seg.segment(canvas);
    const mask = r.confidenceMasks?.[1];
    let keypoints: MaskKeypoint[] = [];
    if (mask) {
      const data = mask.getAsFloat32Array();
      // Rotate the mask back: landscape (W=fh, H=fw) -> portrait (fw x fh), then extract.
      const mw = mask.width, mh = mask.height;
      if (portrait) {
        const pw = mh, ph = mw;
        const back = new Float32Array(pw * ph);
        for (let y = 0; y < mh; y++) for (let x = 0; x < mw; x++) back[x * pw + (pw - 1 - y)] = data[y * mw + x];
        keypoints = blockKeypoints(back, pw, ph, 24, 6, 3, 15);
      } else keypoints = blockKeypoints(data, mw, mh, 24, 6, 3, 15);
      r.confidenceMasks?.forEach((cm) => cm.close());
    }
    post({ type: 'keypoints', id: m.id, keypoints, ms: performance.now() - t0 });
  } catch (err) {
    post({ type: 'error', id: m.id, message: String((err as Error)?.message ?? err) });
  } finally {
    m.frame.close();
  }
};
