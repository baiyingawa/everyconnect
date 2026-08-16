import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/index.ts', 'src/client.ts'],
  outDir: 'lib',
  format: ['esm'],
  outExtensions: () => ({ js: '.js' }),
  clean: true,
  sourcemap: false,
  deps: {
    neverBundle: ['react', 'react/jsx-runtime', '@deepseek-ai/dsh-client-ui-primitives'],
  },
})
