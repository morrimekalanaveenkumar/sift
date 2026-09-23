import type { NextConfig } from 'next';

const PDFJS_RUNTIME_FILES = [
  './node_modules/pdfjs-dist/legacy/build/*.mjs',
  './node_modules/pdfjs-dist/standard_fonts/**',
];

const config: NextConfig = {
  // pg and pdfjs both reach for Node built-ins; they must stay real modules on the server
  // rather than being bundled.
  serverExternalPackages: ['pg', 'pdfjs-dist'],

  // Two sets of pdf.js files that dependency tracing cannot find on its own, both of
  // which a deployed build silently omits:
  //
  //   - `legacy/build/pdf.worker.mjs`, which pdf.js loads through a dynamically built
  //     import path rather than a static `import`. Without it every parse dies with
  //     "Setting up fake worker failed", which is what broke the first deployment.
  //   - `standard_fonts/`, the metrics for the fourteen fonts a PDF may reference
  //     without embedding. These are data files that nothing imports at all.
  //
  // Nothing in the source can hint at either, so they have to be named here.
  outputFileTracingIncludes: {
    // Both key shapes, because a deploy that omits these fails at runtime rather than at
    // build time, and one wasted round trip costs more than a duplicated line.
    '/**': PDFJS_RUNTIME_FILES,
    '/api/**': PDFJS_RUNTIME_FILES,
  },
};

export default config;
