import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Single source of truth for "where this Next.js app lives on disk".
// Used for BOTH `outputFileTracingRoot` (production trace) and
// `turbopack.root` (dev bundler workspace pin). They must resolve to the
// exact same absolute path or Next.js 16 emits:
//   ⚠ Both `outputFileTracingRoot` and `turbopack.root` are set, but they
//   must have the same value.
//
// The repo has a sibling Vite/Express app at ../, with its own
// package-lock.json. Without an explicit root pin, Next.js walks up and
// picks the parent as the workspace root — which conflicts with the
// Vercel project root (= this folder, the Next.js app).
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)));

/** @type {import('next').NextConfig} */
const nextConfig = {
  outputFileTracingRoot: root,
  turbopack: {
    root,
  },
  // The Express scanner runs in a separate Node process (../server). The
  // Next.js app never imports scanner code directly — it calls it over HTTP —
  // so we don't need transpilePackages or serverComponentsExternalPackages.
  reactStrictMode: true,
  experimental: {
    // Per-user data is server-only. Mark these so they're never bundled into
    // client components by accident.
    serverActions: { bodySizeLimit: '1mb' },
  },
};

export default nextConfig;
