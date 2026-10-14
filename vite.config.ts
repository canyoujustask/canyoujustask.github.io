import { defineConfig } from 'vite';
import { audioLibrary } from './scripts/audio-library.mjs';

export default defineConfig({
  base: './',
  plugins: [audioLibrary()],
  build: {
    rollupOptions: { input: { index: 'index.html', projects: 'projects.html' } },
  },
});
