import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    port: 3000
  },
  build: {
    outDir: 'dist',
    rollupOptions: {
      // Three.js & VRM are loaded via CDN importmap in index.html,
      // so mark them as external to avoid bundling duplicates.
      external: ['three', '@pixiv/three-vrm', 'kalidokit']
    }
  },
  optimizeDeps: {
    exclude: ['three', '@pixiv/three-vrm', 'kalidokit']
  },
  assetsInclude: ['**/*.vrm', '**/*.glb', '**/*.gltf']
});
