/** @type {import('next').NextConfig} */
const nextConfig = {
  // Note on workspace-root configuration:
  //
  // The repo has a sibling Vite/Express app at ../ with its own
  // package-lock.json. Earlier versions of this config explicitly pinned
  // `outputFileTracingRoot` and `turbopack.root` to silence the
  // "multiple lockfiles detected" warning. That broke the Vercel
  // post-build step, which expects to find `.next/routes-manifest-deterministic.json`
  // relative to the git checkout root (`/vercel/path0`) — pinning the
  // Next.js root one level deeper made Vercel look for `.next` in the
  // wrong directory.
  //
  // Letting Next.js / Vercel auto-detect the workspace root produces a
  // harmless local warning but a working production build. If we ever
  // need to silence the warning again, the right place is either:
  //   - move web/ to be the actual repo root (and the Vite app elsewhere), or
  //   - convert the repo to an npm workspace so there's a single lockfile.
  reactStrictMode: true,
  experimental: {
    // Per-user data is server-only. Mark Server Actions explicitly so they
    // aren't bundled into client components by accident.
    serverActions: { bodySizeLimit: '1mb' },
  },
};

export default nextConfig;
