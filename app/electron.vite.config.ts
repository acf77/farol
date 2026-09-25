import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        // `mcp` and `git-hook` are their own entries: both run as their own
        // process, started by an agent or by git rather than by the app.
        input: {
          index: resolve(__dirname, 'electron/main.ts'),
          mcp: resolve(__dirname, 'electron/mcp.ts'),
          'git-hook': resolve(__dirname, 'electron/git-hook.ts')
        },
        output: { entryFileNames: '[name].js' }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      lib: { entry: resolve(__dirname, 'electron/preload.ts') },
      rollupOptions: { output: { entryFileNames: 'index.js' } }
    }
  },
  renderer: {
    root: '.',
    plugins: [react()],
    resolve: {
      alias: { '@shared': resolve(__dirname, 'shared') }
    },
    build: {
      rollupOptions: { input: resolve(__dirname, 'index.html') }
    }
  }
})
