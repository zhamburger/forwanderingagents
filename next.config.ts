import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  poweredByHeader: false,
  // Some MCP clients guess /mcp; serve the same endpoint there.
  async rewrites() {
    return [{ source: "/mcp", destination: "/api/mcp" }];
  },
  async headers() {
    return [{ source: "/:path*", headers: [
      { key: "X-Content-Type-Options", value: "nosniff" },
      { key: "X-Frame-Options", value: "DENY" },
      { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
      { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()" },
      { key: "Strict-Transport-Security", value: "max-age=31536000" },
      // Lets crawlers and agents find the machine-readable descriptions from any page.
      { key: "Link", value: '</.well-known/api-catalog>; rel="api-catalog", </openapi.json>; rel="service-desc"; type="application/openapi+json", </llms.txt>; rel="describedby"; type="text/plain"' },
    ] }];
  },
};

export default nextConfig;
