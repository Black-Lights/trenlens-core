import type { MetadataRoute } from 'next';

// Emitted as a static `/manifest.webmanifest` by the export build. `display:
// standalone` + the icons make "Add to Home Screen" launch the PWA chrome-free.
export const dynamic = 'force-static';

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'TrenLens Remote',
    short_name: 'TrenLens',
    description: 'Drive your local TrenLens engine from your phone.',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    orientation: 'portrait',
    background_color: '#0b0f17',
    theme_color: '#0b0f17',
    icons: [
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
      { src: '/icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  };
}
