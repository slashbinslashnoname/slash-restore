import { defineConfig } from 'vitest/config'
import { resolve } from 'path'

export default defineConfig({
  resolve: {
    alias: {
      '@shared': resolve(__dirname, 'src/shared'),
      '@core': resolve(__dirname, 'src/core')
    }
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts']
  }
})
