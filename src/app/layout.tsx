import type { Metadata, Viewport } from 'next';
import { ServiceWorkerRegister } from '@/components/ServiceWorkerRegister';
import './globals.css';

export const metadata: Metadata = {
  title: 'Potaeto – Create & share WHO/WHAT',
  description: 'Create characters and personas, generate content, and share with the world.',
};

export const viewport: Viewport = {
  themeColor: '#ed751a',
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="scrollbar-thin">
      <body className="antialiased min-h-screen">
        {children}
        <ServiceWorkerRegister />
      </body>
    </html>
  );
}
