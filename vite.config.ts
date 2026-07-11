import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import {defineConfig} from 'vite';

export default defineConfig(() => {
  return {
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: [
        // Redirect every bare `sonner` import to our shim (shared-id toasts), and
        // give the shim a `sonner-real` handle back to the real package so it can
        // re-export it without looping. Order matters: `sonner-real` before the
        // `^sonner$` regex, and `@` last.
        { find: 'sonner-real', replacement: path.resolve(__dirname, 'node_modules/sonner') },
        { find: /^sonner$/, replacement: path.resolve(__dirname, 'src/lib/sonnerShim.ts') },
        { find: '@', replacement: path.resolve(__dirname, '.') },
      ],
    },
    build: {
      outDir: 'dist',
      emptyOutDir: true,
    },
    server: {
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modify - file watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
      // Disable file watching when DISABLE_HMR is true to save CPU during agent edits.
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
    },
  };
});
