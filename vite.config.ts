import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  build: {
    cssMinify: 'lightningcss',
  },
  css: {
    lightningcss: {
      // Keep unprefixed backdrop-filter in production (not only -webkit-).
      targets: {
        chrome: 100 << 16,
        firefox: 100 << 16,
        safari: (16 << 16) | (4 << 8),
        ios_saf: (16 << 16) | (4 << 8),
      },
    },
  },
})
