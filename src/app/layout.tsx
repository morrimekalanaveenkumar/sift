import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Sift — turn a pile of documents into a table you can query',
  description:
    'Drop in documents of unknown kinds. Sift works out what they are, what fields they share, and turns them into a Postgres table.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
