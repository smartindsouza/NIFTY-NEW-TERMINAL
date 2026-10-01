import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import {defineConfig} from 'vite';
import fs from 'fs';

// ONE ID PER BUILD, shared by the bundle and dist/version.json. The running app
// compares its own ID with the deployed file to tell whether it is current.
// The git commit (the same 8-character codes quoted after each deploy) when
// Railway provides it during the build; Railway's docs and forum disagree on
// whether it always does, so a build timestamp stands in otherwise. Both sides
// always come from this one value, so the comparison stays valid either way.
const BUILD_TIME = new Date().toISOString();
const BUILD_SHA = (process.env.RAILWAY_GIT_COMMIT_SHA || '').slice(0, 8);
const BUILD_ID = BUILD_SHA || BUILD_TIME.replace(/[-:TZ.]/g, '').slice(0, 14);

export default defineConfig(() => {
  return {
    plugins: [react(), tailwindcss(), {
      // Writes dist/version.json, served as a static file — the deployed build's
      // identity, which the app fetches (uncached) to detect it is out of date.
      name: 'build-version-file',
      apply: 'build',
      closeBundle() {
        try {
          fs.writeFileSync(path.resolve(__dirname, 'dist', 'version.json'),
            JSON.stringify({ id: BUILD_ID, sha: BUILD_SHA || null, builtAt: BUILD_TIME }));
        } catch (e) { console.warn('[build-version-file] could not write version.json', e); }
      },
    }],
    // Baked in at build time so the running bundle can identify itself — ends the
    // "did my phone actually load the new build?" question that has cost several
    // rounds of judging fixes against a stale service-worker bundle.
    define: {
      __BUILD_TIME__: JSON.stringify(BUILD_TIME),
      __BUILD_ID__: JSON.stringify(BUILD_ID),
      __BUILD_SHA__: JSON.stringify(BUILD_SHA),
    },
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
