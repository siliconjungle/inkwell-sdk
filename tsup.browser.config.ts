import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { 'inkwell.browser': 'src/browser.ts' },
  outDir: 'dist',
  format: ['iife'],
  outExtension: () => ({ js: '.js' }),
  platform: 'browser',
  target: 'es2022',
  clean: false,
  dts: false,
  splitting: false,
  sourcemap: true,
  minify: true,
});
