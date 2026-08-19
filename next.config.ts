import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ['@ffmpeg-installer/ffmpeg', 'fluent-ffmpeg', 'tesseract.js', 'tesseract.js-core'],
};

export default nextConfig;
