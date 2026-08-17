import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.spec.ts'],
    exclude: ['tests/**/*.client.spec.ts', 'tests/**/*.client.spec.tsx'],
  },
})
