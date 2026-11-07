import type { NextConfig } from 'next';

/**
 * Next.js 16 refuses dev-only assets (the HMR socket and dev resources) from
 * origins it was not told about. The preview panel serves this app from a
 * *.style.dev origin, so without this list the page renders but parts of the
 * client runtime are blocked. Extra origins can be added with a comma-separated
 * AC_ALLOWED_DEV_ORIGINS without touching the source.
 */
const extraDevOrigins = (process.env.AC_ALLOWED_DEV_ORIGINS ?? '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

const nextConfig: NextConfig = {
  // FFmpeg binaries, ffprobe and archiver are native/CJS packages that must not be
  // bundled by the server compiler.
  serverExternalPackages: ['ffmpeg-static', '@ffprobe-installer/ffprobe', 'archiver'],
  // The caption font has to ship with the server build so libass can find it at runtime.
  outputFileTracingIncludes: {
    '/api/**': ['./assets/fonts/**'],
    '/projects/**': ['./assets/fonts/**'],
  },
  // Local Whisper's virtualenv and model cache are runtime state, not server
  // code: the venv's python is a symlink to a system interpreter and the model
  // cache is hundreds of MB. Tracing them fails the build, so keep them out.
  outputFileTracingExcludes: {
    '/**': ['./.venv-whisper/**', './.whisper-models/**', './data/**', './.smoke/**'],
  },
  // Development only: ignored by `next build` / `next start`.
  allowedDevOrigins: ['*.style.dev', ...extraDevOrigins],
};

export default nextConfig;
