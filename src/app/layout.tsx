import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'AutoClipper — AI video clipping for vertical video',
  description:
    'Upload a recording, let AutoClipper transcribe it, find the moments worth watching and render real 9:16 clips with synchronized captions.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" data-scroll-behavior="smooth">
      <body className="min-h-screen bg-ink-950 font-sans text-white">{children}</body>
    </html>
  );
}
