// Copies runtime WASM from node_modules into public/vendor and downloads the
// detector models into public/models, so that the app can serve every file
// itself (no CDN at runtime, works offline once cached). Idempotent.
import { copyFile, mkdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pub = join(root, 'public');

const copies = [
  ['node_modules/@mediapipe/tasks-vision/wasm/vision_wasm_internal.js', 'vendor/mediapipe/vision_wasm_internal.js'],
  ['node_modules/@mediapipe/tasks-vision/wasm/vision_wasm_internal.wasm', 'vendor/mediapipe/vision_wasm_internal.wasm'],
  ['node_modules/@mediapipe/tasks-vision/wasm/vision_wasm_nosimd_internal.js', 'vendor/mediapipe/vision_wasm_nosimd_internal.js'],
  ['node_modules/@mediapipe/tasks-vision/wasm/vision_wasm_nosimd_internal.wasm', 'vendor/mediapipe/vision_wasm_nosimd_internal.wasm'],
  ['node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.jsep.wasm', 'vendor/ort/ort-wasm-simd-threaded.jsep.wasm'],
  ['node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.jsep.mjs', 'vendor/ort/ort-wasm-simd-threaded.jsep.mjs'],
];

// All Apache-2.0 licensed.
const downloads = [
  [
    'https://storage.googleapis.com/mediapipe-models/object_detector/efficientdet_lite0/float16/latest/efficientdet_lite0.tflite',
    'models/efficientdet_lite0.tflite',
  ],
  [
    'https://storage.googleapis.com/mediapipe-models/object_detector/efficientdet_lite2/float16/latest/efficientdet_lite2.tflite',
    'models/efficientdet_lite2.tflite',
  ],
  [
    'https://github.com/Megvii-BaseDetection/YOLOX/releases/download/0.1.1rc0/yolox_nano.onnx',
    'models/yolox_nano.onnx',
  ],
];

async function exists(p) {
  try {
    return (await stat(p)).size > 0;
  } catch {
    return false;
  }
}

for (const [from, to] of copies) {
  const dest = join(pub, to);
  await mkdir(dirname(dest), { recursive: true });
  await copyFile(join(root, from), dest);
}
console.log(`[assets] copied ${copies.length} runtime files`);

for (const [url, to] of downloads) {
  const dest = join(pub, to);
  if (await exists(dest)) continue;
  await mkdir(dirname(dest), { recursive: true });
  process.stdout.write(`[assets] downloading ${to} ... `);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to download ${url}: ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  await writeFile(dest, buf);
  console.log(`${(buf.length / 1e6).toFixed(1)} MB`);
}
console.log('[assets] ready');
