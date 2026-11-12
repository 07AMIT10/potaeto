/** @type {import('next').NextConfig} */
const coreUrl = (process.env.NEXT_PUBLIC_CORE_URL ?? '').trim();
const allowLocalCoreUrl = process.env.POTAETO_ALLOW_LOCAL_CORE_URL === '1';

// `NEXT_PUBLIC_*` values are inlined into the browser bundle at build time. A
// developer `.env.local` that points at localhost would therefore bake the
// phone's own loopback into a production build, so fail loudly instead of
// shipping an app that cannot reach the core. Production builds are
// same-origin (relative `/v1/*` proxied by Caddy) and must leave it empty.
if (process.env.NODE_ENV === 'production' && coreUrl && !allowLocalCoreUrl) {
  throw new Error(
    [
      'NEXT_PUBLIC_CORE_URL is set for a production build.',
      'NEXT_PUBLIC_* values are inlined into the client bundle, so a dev',
      '`.env.local` would ship the dev core URL http://localhost:8000 to real devices.',
      'Build with NEXT_PUBLIC_CORE_URL empty (same-origin /v1/* via Caddy),',
      'or set POTAETO_ALLOW_LOCAL_CORE_URL=1 only for a deliberate local build.',
    ].join(' '),
  );
}

const nextConfig = {
  output: 'export',
  reactStrictMode: true,
  images: { unoptimized: true },
};

export default nextConfig;
