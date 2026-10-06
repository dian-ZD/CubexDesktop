import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'

export default defineConfig({
  main: {
    build: {
      externalizeDeps: false,
      rollupOptions: {
        input: { index: resolve('src/main/index.ts') },
        output: { entryFileNames: '[name].js' },
      },
    },
  },
  preload: {
    build: { externalizeDeps: false, rollupOptions: { output: { format: 'cjs', entryFileNames: '[name].cjs' } } },
  },
  renderer: {
    plugins: [react()],
    worker: { format: 'es' },
    optimizeDeps: { exclude: ['@xenova/transformers'] },
    build: {
      minify: 'esbuild',
      target: 'chrome140',
      modulePreload: { polyfill: false },
      rollupOptions: { output: { manualChunks: (id) => (id.includes('node_modules/react') || id.includes('node_modules/scheduler') ? 'react' : undefined) } },
    },
  },
})
