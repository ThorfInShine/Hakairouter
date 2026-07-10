export default function manifest() {
  return {
    name: '9Router - AI Router & Token Saver',
    short_name: '9Router',
    description: 'Cyberpunk-style AI routing gateway. Connect 40+ providers with auto-fallback, token compression, and multi-account support.',
    start_url: '/',
    display: 'standalone',
    background_color: '#0d1117',
    theme_color: '#ff4444',
    orientation: 'portrait-primary',
    icons: [
      {
        src: '/icons/icon-192.ico',
        sizes: '192x192',
        type: 'image/x-icon',
      },
      {
        src: '/icons/icon-512.ico',
        sizes: '512x512',
        type: 'image/x-icon',
      },
      {
        src: '/icons/icon-512.ico',
        sizes: '512x512',
        type: 'image/x-icon',
        purpose: 'maskable',
      },
    ],
  }
}
