import { defaultClientConditions, defineConfig, type PluginOption } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';
import basicSsl from '@vitejs/plugin-basic-ssl';

// Phones only allow camera access on secure origins. `npm run dev:https`
// serves the dev build over a self-signed certificate for LAN testing.
export default defineConfig(({ mode }) => {
  const plugins: PluginOption[] = [
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: 'auto',
      includeAssets: ['icons/*.png', 'icons/*.svg'],
      manifest: {
        name: 'EchoPath',
        short_name: 'EchoPath',
        description:
          'Hear what is ahead of you. Obstacles and people become directional sounds, processed entirely on your phone.',
        theme_color: '#000000',
        background_color: '#000000',
        display: 'standalone',
        orientation: 'any',
        start_url: '.',
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // The default model and the MediaPipe runtime are precached so the app
        // works in airplane mode after the first visit. Larger optional models
        // are cached the first time they are used (or via Settings).
        globPatterns: [
          '**/*.{js,css,html,svg,png,webmanifest}',
          'models/efficientdet_lite0.tflite',
          'vendor/mediapipe/vision_wasm_internal.{js,wasm}',
        ],
        globIgnores: ['vendor/ort/**'],
        maximumFileSizeToCacheInBytes: 40 * 1024 * 1024,
        runtimeCaching: [
          {
            urlPattern: ({ url }) => url.pathname.includes('/models/') || url.pathname.includes('/vendor/'),
            handler: 'CacheFirst',
            options: { cacheName: 'echopath-models', expiration: { maxEntries: 20 } },
          },
        ],
      },
    }),
  ];
  if (mode === 'https') plugins.push(basicSsl());

  return {
    base: './',
    plugins,
    // ONNX Runtime's "extern wasm" build loads its WASM from public/vendor/ort
    // instead of bundling a second 22 MB copy into assets/.
    resolve: { conditions: ['onnxruntime-web-use-extern-wasm', ...defaultClientConditions] },
    worker: { format: 'es' },
    optimizeDeps: { exclude: ['onnxruntime-web'] },
    build: { target: 'es2022', chunkSizeWarningLimit: 2000 },
    test: { environment: 'node', include: ['src/**/*.test.ts'] },
  };
});
