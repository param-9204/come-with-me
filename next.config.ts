import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ['@ffmpeg-installer/ffmpeg', 'fluent-ffmpeg', 'tesseract.js', 'tesseract.js-core'],
  outputFileTracingIncludes: {
    '/api/**/*': [
      './node_modules/tesseract.js/**/*',
      './node_modules/tesseract.js-core/**/*',
    ],
  },
};

export default nextConfig;
