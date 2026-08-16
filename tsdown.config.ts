import { defineConfig } from 'tsdown'

const shared = {
  outExtensions: () => ({ js: '.js' }),
  sourcemap: false,
  deps: {
    neverBundle: ['react', 'react/jsx-runtime', '@deepseek-ai/dsh-client-ui-primitives'],
  },
}

export default [
  defineConfig({
    ...shared,
    entry: ['src/index.ts'],
    outDir: 'lib',
    format: ['esm'],
    clean: true,
  }),
  defineConfig({
    ...shared,
    entry: ['src/client.ts'],
    outDir: 'lib/.client-build',
    format: ['cjs'],
    clean: false,
    deps: {
      ...shared.deps,
      alwaysBundle: [/^qrcode(?:\/|$)/],
    },
  }),
]
