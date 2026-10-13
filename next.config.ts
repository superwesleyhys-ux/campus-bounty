import type { NextConfig } from "next";
const config: NextConfig = {
  output: "standalone",
  outputFileTracingRoot: process.cwd(),
  outputFileTracingExcludes: {
    "/*": ["./.data/**/*", "./.git/**/*", "./tests/**/*", "./docs/**/*"],
  },
  poweredByHeader: false,
  devIndicators: false,
  distDir: process.env.CAMPUS_BUILD_DIR || ".next",
  serverExternalPackages: ["node:sqlite"],
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "same-origin" },
          // The disposable loopback fixture uses a same-origin iframe for
          // responsive checks. Every normal development/production run denies framing.
          {
            key: "X-Frame-Options",
            value:
              process.env.NODE_ENV === "development" &&
              process.env.CAMPUS_BUILD_DIR === ".next-interaction"
                ? "SAMEORIGIN"
                : "DENY",
          },
        ],
      },
    ];
  },
};
export default config;
