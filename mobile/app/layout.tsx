import type { Metadata, Viewport } from 'next';

import './globals.css';
import { ServiceWorkerRegister } from '@/components/ServiceWorkerRegister';

export const metadata: Metadata = {
  title: 'TrenLens Remote',
  description: 'Control your local TrenLens engine from your phone.',
  applicationName: 'TrenLens Remote',
  manifest: '/manifest.webmanifest',
  // iOS standalone chrome + status bar styling for "Add to Home Screen".
  appleWebApp: { capable: true, title: 'TrenLens', statusBarStyle: 'black-translucent' },
  icons: {
    icon: [
      { url: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
      { url: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
    ],
    apple: [{ url: '/icons/apple-touch-icon.png', sizes: '180x180', type: 'image/png' }],
  },
};

// Mobile-first: lock the viewport so the UI behaves like an app; `viewportFit:cover`
// lets us pad with the safe-area insets (notch / home indicator).
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  themeColor: '#0b0f17',
  viewportFit: 'cover',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        {children}
        <ServiceWorkerRegister />
      </body>
    </html>
  );
}
