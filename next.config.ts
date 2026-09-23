import type { NextConfig } from 'next';

const config: NextConfig = {
  // pg and pdfjs both reach for Node built-ins; they must stay real modules on the server
  // rather than being bundled.
  serverExternalPackages: ['pg', 'pdfjs-dist'],

  // pdf.js reads the fourteen standard PDF font files at runtime, and nothing imports
  // them, so dependency tracing leaves them out of a deployed build. Naming them here is
  // what puts them in the bundle.
  outputFileTracingIncludes: {
    '/**': ['./node_modules/pdfjs-dist/standard_fonts/**'],
  },
};

export default config;
