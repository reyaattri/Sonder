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
  // Depth Anything V2 Small (Apache-2.0): monocular depth for the virtual cane and echolocation.
  [
    'https://huggingface.co/onnx-community/depth-anything-v2-small/resolve/main/onnx/model_fp16.onnx',
    'models/depth_anything_v2_small_fp16.onnx',
  ],
  [
    'https://huggingface.co/onnx-community/depth-anything-v2-small/resolve/main/onnx/model_quantized.onnx',
    'models/depth_anything_v2_small_q8.onnx',
  ],
  // The guide-line sound pack (Apache-2.0, see THIRD_PARTY_NOTICES.md).
  ['https://raw.githubusercontent.com/google-research/project-guideline/main/project_guideline/audio/assets/legacy_v4_2_steering.ogg', 'sounds/pg/legacy_v4_2_steering.ogg'],
  ['https://raw.githubusercontent.com/google-research/project-guideline/main/project_guideline/audio/assets/legacy_v4_2_warning.ogg', 'sounds/pg/legacy_v4_2_warning.ogg'],
  ['https://raw.githubusercontent.com/google-research/project-guideline/main/project_guideline/audio/assets/legacy_v4_2_stop.ogg', 'sounds/pg/legacy_v4_2_stop.ogg'],
  ['https://raw.githubusercontent.com/google-research/project-guideline/main/project_guideline/audio/assets/obstacle.ogg', 'sounds/pg/obstacle.ogg'],
  ['https://raw.githubusercontent.com/google-research/project-guideline/main/project_guideline/audio/assets/turn.ogg', 'sounds/pg/turn.ogg'],
  ['https://raw.githubusercontent.com/google-research/project-guideline/main/project_guideline/audio/assets/turn_fast.ogg', 'sounds/pg/turn_fast.ogg'],
  ['https://raw.githubusercontent.com/google-research/project-guideline/main/project_guideline/audio/assets/ready.ogg', 'sounds/pg/ready.ogg'],
  ['https://raw.githubusercontent.com/google-research/project-guideline/main/project_guideline/audio/assets/loading.ogg', 'sounds/pg/loading.ogg'],
  ['https://raw.githubusercontent.com/google-research/project-guideline/main/project_guideline/audio/assets/stopstopstop.ogg', 'sounds/pg/stopstopstop.ogg'],
  ['https://raw.githubusercontent.com/google-research/project-guideline/main/project_guideline/audio/assets/steering_on_course_impulse_tick.ogg', 'sounds/pg/steering_on_course_impulse_tick.ogg'],
  ['https://raw.githubusercontent.com/google-research/project-guideline/main/project_guideline/audio/assets/steering_off_course_impulse_tick.ogg', 'sounds/pg/steering_off_course_impulse_tick.ogg'],
  ['https://raw.githubusercontent.com/google-research/project-guideline/main/project_guideline/audio/assets/slightleft.ogg', 'sounds/pg/slightleft.ogg'],
  ['https://raw.githubusercontent.com/google-research/project-guideline/main/project_guideline/audio/assets/slightright.ogg', 'sounds/pg/slightright.ogg'],
  ['https://raw.githubusercontent.com/google-research/project-guideline/main/project_guideline/audio/assets/midleft.ogg', 'sounds/pg/midleft.ogg'],
  ['https://raw.githubusercontent.com/google-research/project-guideline/main/project_guideline/audio/assets/midright.ogg', 'sounds/pg/midright.ogg'],
  ['https://raw.githubusercontent.com/google-research/project-guideline/main/project_guideline/audio/assets/sharpleft.ogg', 'sounds/pg/sharpleft.ogg'],
  ['https://raw.githubusercontent.com/google-research/project-guideline/main/project_guideline/audio/assets/sharpright.ogg', 'sounds/pg/sharpright.ogg'],
  ['https://raw.githubusercontent.com/google-research/project-guideline/main/project_guideline/audio/assets/straight.ogg', 'sounds/pg/straight.ogg'],
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
