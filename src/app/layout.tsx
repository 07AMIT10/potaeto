import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Potaeto – Create & share WHO/WHAT',
  description: 'Create characters and personas, generate content, and share with the world.',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="scrollbar-thin">
      <body className="antialiased min-h-screen">{children}</body>
    </html>
  );
}
