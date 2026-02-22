import type { MetadataRoute } from 'next';

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Potaeto',
    short_name: 'Potaeto',
    description: 'Create WHO and WHAT you want to build. Generate and share content.',
    start_url: '/',
    display: 'standalone',
    background_color: '#fef7ee',
    theme_color: '#ed751a',
    icons: [
      {
        src: '/icon-192.png',
        sizes: '192x192',
        type: 'image/png',
        purpose: 'any maskable',
      },
      {
        src: '/icon-512.png',
        sizes: '512x512',
        type: 'image/png',
        purpose: 'any maskable',
      },
    ],
  };
}
