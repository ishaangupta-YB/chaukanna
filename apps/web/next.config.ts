import type { NextConfig } from "next";

/**
 * Security headers on every response.
 * - Permissions-Policy: product rule 7, no camera anywhere; the microphone only on our own origin.
 * - Framing is denied, so no other site can wrap the consent button or the kill switch.
 * - Invite tokens live in /join/<token> URLs, so no page ever sends a referrer.
 */
const securityHeaders = [
  { key: "Permissions-Policy", value: "camera=(), microphone=(self), geolocation=(), payment=(), usb=()" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
  { key: "Referrer-Policy", value: "no-referrer" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" },
];

const nextConfig: NextConfig = {
  poweredByHeader: false,
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
