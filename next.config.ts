import type { NextConfig } from 'next';

const config: NextConfig = {
  // pg and pdfjs both reach for Node built-ins; they must stay real modules on the server
  // rather than being bundled.
  serverExternalPackages: ['pg', 'pdfjs-dist'],
};

export default config;
