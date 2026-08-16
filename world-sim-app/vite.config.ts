import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

/**
 * Builds to one self-contained HTML file, the same constraint `track-viz`'s
 * visualiser works under: it has to open from `file://`, offline, with no CDN
 * and nothing fetched at runtime. Scenes are inlined by `import.meta.glob(...,
 * '?raw')`, so a built page carries its own library of terrain.
 */
export default defineConfig({
  base: './',
  plugins: [viteSingleFile({ removeViteModuleLoader: true })],
  build: {
    target: 'es2020',
    assetsInlineLimit: 100_000_000,
    cssCodeSplit: false,
    outDir: 'dist',
    rollupOptions: { output: { inlineDynamicImports: true } },
  },
});
