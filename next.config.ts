import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ['@ffmpeg-installer/ffmpeg', 'fluent-ffmpeg', 'tesseract.js', 'tesseract.js-core'],
  outputFileTracingIncludes: {
    '/api/**/*': [
      './node_modules/tesseract.js/**/*',
      './node_modules/tesseract.js-core/**/*',
      './node_modules/bmp-js/**/*',
      './node_modules/zlibjs/**/*',
      './node_modules/is-url/**/*',
      './node_modules/node-fetch/**/*',
      './node_modules/wasm-feature-detect/**/*',
      './node_modules/idb-keyval/**/*',
      './node_modules/regenerator-runtime/**/*',
    ],
  },
};

export default nextConfig;
