import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Pin Turbopack's workspace root to this folder. Without this, Next.js
  // walks up the tree and picks up the root Vite app's package-lock.json,
  // producing a noisy warning at build time.
  turbopack: {
    root: __dirname,
  },
  // The scanner runs in a separate Node process (../server). The Next.js app
  // never imports scanner code directly — it calls it over HTTP — so we don't
  // need transpilePackages or serverComponentsExternalPackages config here.
  reactStrictMode: true,
  experimental: {
    // Per-user data is server-only. Mark these so they're never bundled into
    // client components by accident.
    serverActions: { bodySizeLimit: '1mb' },
  },
};

export default nextConfig;
