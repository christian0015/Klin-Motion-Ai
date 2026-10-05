//next.config.ts
/**
 * next.config.ts — en-têtes de sécurité (CSP, HSTS, nosniff, Referrer-Policy, frame-ancestors, Permissions-Policy)
 * et cache long des statiques versionnés (sfx, lut, polices, modèles 3D : nom versionné `_v1`).
 * Ne contient PAS : logique applicative.
 */
import type { NextConfig } from "next";

const dev = process.env.NODE_ENV !== "production";
const r2 = process.env.R2_ACCOUNT_ID ? `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com` : "https://*.r2.cloudflarestorage.com";
const csp = [
  "default-src 'self'",
  `script-src 'self' blob: 'unsafe-inline' 'wasm-unsafe-eval'${dev ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com data:",
  "img-src 'self' data: blob: https://*.googleusercontent.com",
  "media-src 'self' blob:",
  `connect-src 'self' blob: ${r2}${dev ? " ws: wss:" : ""}`,
  "worker-src 'self' blob:",
  "frame-ancestors 'none'", "base-uri 'self'", "object-src 'none'",
  "form-action 'self' https://accounts.google.com",
].join("; ");

const immutable = [{ key: "Cache-Control", value: "public, max-age=31536000, immutable" }];

const config: NextConfig = {
  reactStrictMode: true,
  serverExternalPackages: ["mongoose", "mongodb"],
  async headers() {
    return [
      { source: "/:path*", headers: [
        { key: "Content-Security-Policy", value: csp },
        { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
        { key: "X-Content-Type-Options", value: "nosniff" },
        { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()" },
      ] },
      ...["sfx", "lut", "fonts", "models"].map((d) => ({ source: `/${d}/:path*`, headers: immutable })),
    ];
  },
};
export default config;
