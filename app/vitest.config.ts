import { defineConfig } from 'vitest/config'
import { dirname, resolve } from 'path'
import { fileURLToPath } from 'url'

const root = dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  resolve: {
    alias: { '@shared': resolve(root, 'shared') }
  },
  setupFiles: ['./src/test-setup.ts']
})