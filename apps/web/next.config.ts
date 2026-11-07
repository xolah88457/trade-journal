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
    "@transcribe-cpp/darwin-x64-cpu",
    "@transcribe-cpp/linux-x64-cpu-vulkan",
    "@transcribe-cpp/linux-arm64-cpu-vulkan",
    "@transcribe-cpp/win32-x64-cpu-vulkan",
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
