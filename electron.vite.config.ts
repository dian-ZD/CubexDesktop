import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'

export default defineConfig({
  main: {
    build: {
      // 保持内联打包（files 配置排除了 node_modules，外置会导致打包产物缺依赖）；主进程启动优化主要靠渲染层瘦身与建窗提前
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
      rollupOptions: {
        output: {
          manualChunks: (id) => {
            if (id.includes('node_modules/react') || id.includes('node_modules/scheduler')) return 'react'
            // zod 独立成块：只在设置校验路径用到，与业务代码分开利于缓存
            if (id.includes('node_modules/zod')) return 'zod'
            return undefined
          },
        },
      },
    },
  },
})
