import type { ReactNode } from 'react';
import './globals.css';

export const metadata = {
  title: '漢詩檢索 — Classical Chinese poetry search',
  description: 'Fragment lookup over the chinese-poetry corpus',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="zh-Hant">
      <body>{children}</body>
    </html>
  );
}
