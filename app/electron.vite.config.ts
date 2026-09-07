import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        // `mcp` is a second entry: the MCP server runs as its own process,
        // started by an agent rather than by the app.
        input: {
          index: resolve(__dirname, 'electron/main.ts'),
          mcp: resolve(__dirname, 'electron/mcp.ts')
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
