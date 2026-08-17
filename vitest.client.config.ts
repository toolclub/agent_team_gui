import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'happy-dom',
    include: [
      'tests/**/*.client.spec.ts',
      'tests/**/*.client.spec.tsx',
    ],
    setupFiles: ['tests/smoke/client-setup.ts'],
    restoreMocks: true,
    clearMocks: true,
  },
})
