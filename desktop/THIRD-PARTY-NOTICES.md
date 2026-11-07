# Sumi — third-party notices

Sumi is an independent local desktop adaptation, not an official product of LuxAlgo or Tw93.

- Journal application: [LuxAlgo Trade Journal](https://github.com/LuxAlgo/trade-journal), copyright LuxAlgo Global, LLC, MIT. See `Trade-Journal-MIT.txt` in the built app.
- Theme influences: [Kami](https://github.com/tw93/Kami), copyright 2026 Tw93, MIT. See `Kami-MIT.txt`. Sumi adapts Kami's parchment/ivory/navy palette and editorial typography. No Kami logo or remotely hosted fonts are used.
- Runtime: Node.js and its bundled dependencies. See `Node-LICENSE.txt`.
- Desktop framework: [Electron](https://github.com/electron/electron), Copyright (c) Electron contributors, Copyright (c) GitHub Inc., MIT License. See `Electron-LICENSE.txt`.
- Software update framework (macOS): [Sparkle](https://sparkle-project.org/), Copyright (c) 2006-2013 Andy Matuschak, Copyright (c) 2009-2013 Elgato Systems GmbH, Copyright (c) 2011-2014 Kornel Lesiński. MIT License. See `Sparkle-LICENSE.txt`.
- Software update framework (Windows & Linux): [electron-updater](https://github.com/electron-userland/electron-builder), version 6.8.11, Copyright (c) electron-userland, MIT License. Coordinates update discovery, manual user consent prompts, checksum verification, and graceful restart.
- Web rendering and browser engine: Chromium and underlying components. Governed by BSD, MIT, LGPL, and other open-source licenses. Full notices are bundled in `LICENSES.chromium.html`.
- Data compression: [fflate](https://github.com/101arrowz/fflate), Copyright (c) 2020 Arjun Barrett, MIT License. High-performance compression library used in data handling.
- Linux package runtimes: [AppImage](https://appimage.org/) runtime (MIT License) and standard Debian packaging tools (`dpkg`).
- Web framework and other dependencies retain their original licenses. Dependency license files are collected in `licenses/dependencies/` in the app bundle.
- Apple Cocoa and WebKit are system frameworks supplied by macOS.

## Microsoft Visual C++ Runtime Notice (Windows)

Microsoft Visual C++ Runtime (MSVCP140.dll, VCRUNTIME140.dll, VCRUNTIME140_1.dll)
Redistributed under Visual Studio 2015-2022 Redistributable License Terms for local application runtime.

- **Provenance**: The Microsoft Visual C++ x64 CRT DLLs (`msvcp140.dll`, `vcruntime140.dll`, `vcruntime140_1.dll`) are resolved from official Microsoft Visual Studio Build Tools / VC Tools Redistributable directories during the Windows desktop build (`desktop/build.mjs`) and packaged app-local into `resources/runtime/` and native module directories.
- **Purpose**: App-local bundling ensures native C++ modules (such as `transcribe.dll` and `ggml`) execute reliably on fresh Windows installations without requiring users to separately install the system-wide Microsoft Visual C++ Redistributable.
- **Code Signing**: Sumi desktop binaries for Windows are distributed independently without a commercial Authenticode digital signature.

## Local Voice Runtime & Model Notices

Software runtime libraries are MIT-licensed; speech recognition model weights are downloaded to user data outside the application bundle and are not redistributed within the application packages.

### transcribe.cpp

- Package: `transcribe-cpp` (0.4.1) and platform native binaries:
  - `@transcribe-cpp/darwin-arm64-metal` (macOS Apple Silicon, Metal GPU + CPU)
  - `@transcribe-cpp/darwin-x64-cpu` (macOS Intel x64, CPU)
  - `@transcribe-cpp/win32-x64-cpu-vulkan` (Windows x64, CPU + optional Vulkan)
  - `@transcribe-cpp/linux-x64-cpu-vulkan` (Linux x64, CPU + optional Vulkan)
- GPU & Vector Requirements: External or dedicated GPU is **NOT required** on Windows or Linux; CPU inference is fully supported out of the box (with standard cpu-x64 fallback alongside SSE4.2/AVX variants; AVX/AVX2 is not generally required) and operates by default.
- License: MIT License, Copyright (c) 2024-present The transcribe.cpp authors
- Repository: https://github.com/handy-computer/transcribe.cpp

### Silero VAD

- Asset: `silero-vad-v6.2-F32.gguf` (1,241,056 bytes, ~1.2 MB)
- License: MIT License, Copyright (c) 2020-present Silero Team
- Upstream: https://github.com/snakers4/silero-vad
- Packaging note: Bundled self-contained within application packages across all platforms at `models/silero-vad-v6.2-F32.gguf`.

### Parakeet Unified EN 0.6B (GGUF)

- Manifest: repository `handy-computer/parakeet-unified-en-0.6b-gguf`, commit `7e948f21b7bdbac698d3318db9d350f1096f3b6c`, file `parakeet-unified-en-0.6b-Q8_0.gguf` (~697 MiB / 731,357,568 bytes).
- Upstream Base Model: NVIDIA Parakeet Unified EN 0.6B (`nvidia/parakeet-unified-en-0.6b` at commit `d4ac992`).
- Modifications: handy-computer converted the base checkpoint to GGUF format and Q8_0 quantization for transcribe.cpp without retraining or fine-tuning weights.
- Upstream Model Card License Terms:
  - Repository metadata header specifies: `license: cc-by-4.0` (Creative Commons Attribution 4.0 International, https://creativecommons.org/licenses/by/4.0/).
  - Section "License" states: "Inherited from the base model: CC-BY-4.0. See the upstream model card for full terms."
  - Embedded Original Model Card states: "Governing Terms: Use of the model is governed by the NVIDIA Open Model License Agreement (https://www.nvidia.com/en-us/agreements/enterprise-software/nvidia-open-model-license/)."
  - Required Attribution Notice: "Licensed by NVIDIA Corporation under the NVIDIA Open Model License".
- Distribution note: Heavy ASR model weights (~697 MiB) are **not bundled** inside `Sumi.app`, `.deb`, `.AppImage`, or Windows setup/portable packages. They are downloaded outside the application bundle to user local storage (`~/Library/Application Support/Sumi/voice` on macOS, `%APPDATA%\Sumi\voice` on Windows, `$XDG_CONFIG_HOME/Sumi/voice` on Linux) or reused read-only from your existing local HuggingFace cache upon explicit user request. The lightweight Silero VAD asset (1.2 MB, MIT license) is bundled self-contained within the application bundle at `models/silero-vad-v6.2-F32.gguf`.

The original repository's MIT license and trademark policy remain unchanged. Sumi uses its own product name and mark. References to upstream names are attribution, not endorsement.
