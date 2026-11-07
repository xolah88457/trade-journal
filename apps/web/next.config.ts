import type { NextConfig } from "next";
import { join } from "node:path";

const nextConfig: NextConfig = {
  output: "standalone",
  outputFileTracingRoot: join(__dirname, "../.."),
  transpilePackages: ["@luxalgo/journal-core", "@luxalgo/journal-importers"],
  serverExternalPackages: [
    "better-sqlite3",
    "transcribe-cpp",
    "@transcribe-cpp/darwin-arm64-metal",
    "koffi",
  ],
  // Runtime journal files and model weights belong on the user's disk, never in a deployable bundle.
  outputFileTracingExcludes: {
    "/*": [
      "./data/**/*",
      "../../outputs/**/*",
      "../../.runtime-backup*/**/*",
      "../../models/**/*",
      "**/*.gguf",
    ],
  },
};

export default nextConfig;
