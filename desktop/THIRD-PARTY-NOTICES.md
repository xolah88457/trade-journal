# Sumi — third-party notices

Sumi is an independent local desktop adaptation, not an official product of LuxAlgo or Tw93.

- Journal application: [LuxAlgo Trade Journal](https://github.com/LuxAlgo/trade-journal), copyright LuxAlgo Global, LLC, MIT. See `Trade-Journal-MIT.txt` in the built app.
- Theme influences: [Kami](https://github.com/tw93/Kami), copyright 2026 Tw93, MIT. See `Kami-MIT.txt`. Sumi adapts Kami's parchment/ivory/navy palette and editorial typography. No Kami logo or remotely hosted fonts are used.
- Runtime: Node.js and its bundled dependencies. See `Node-LICENSE.txt`.
- Desktop framework: [Electron](https://github.com/electron/electron), Copyright (c) Electron contributors, Copyright (c) GitHub Inc., MIT License. See `Electron-LICENSE.txt`.
- Software update framework: [Sparkle](https://sparkle-project.org/), Copyright (c) 2006-2013 Andy Matuschak, Copyright (c) 2009-2013 Elgato Systems GmbH, Copyright (c) 2011-2014 Kornel Lesiński. MIT License. See `Sparkle-LICENSE.txt`.
- Web rendering and browser engine: Chromium and underlying components. Governed by BSD, MIT, LGPL, and other open-source licenses. Full notices are bundled in `LICENSES.chromium.html`.
- Data compression: [fflate](https://github.com/101arrowz/fflate), Copyright (c) 2020 Arjun Barrett, MIT License. High-performance compression library used in data handling.
- Web framework and other dependencies retain their original licenses. Dependency license files are collected in `licenses/dependencies/` in the app bundle.
- Apple Cocoa and WebKit are system frameworks supplied by macOS.

## Local Voice Runtime & Model Notices

Software runtime libraries are MIT-licensed; model weights are downloaded to user data outside the application bundle and are not redistributed within the `.app`.

### transcribe.cpp

- Package: `transcribe-cpp` and `@transcribe-cpp/darwin-arm64-metal`
- License: MIT License, Copyright (c) 2024-present The transcribe.cpp authors
- Repository: https://github.com/handy-computer/transcribe.cpp

### Silero VAD

- Asset: `silero-vad-v6.2-F32.gguf`
- License: MIT License, Copyright (c) 2020-present Silero Team
- Upstream: https://github.com/snakers4/silero-vad

### Parakeet Unified EN 0.6B (GGUF)

- Manifest: repository `handy-computer/parakeet-unified-en-0.6b-gguf`, commit `7e948f21b7bdbac698d3318db9d350f1096f3b6c`, file `parakeet-unified-en-0.6b-Q8_0.gguf`.
- Upstream Base Model: NVIDIA Parakeet Unified EN 0.6B (`nvidia/parakeet-unified-en-0.6b` at commit `d4ac992`).
- Modifications: handy-computer converted the base checkpoint to GGUF format and Q8_0 quantization for transcribe.cpp without retraining or fine-tuning weights.
- Upstream Model Card License Terms:
  - Repository metadata header specifies: `license: cc-by-4.0` (Creative Commons Attribution 4.0 International, https://creativecommons.org/licenses/by/4.0/).
  - Section "License" states: "Inherited from the base model: CC-BY-4.0. See the upstream model card for full terms."
  - Embedded Original Model Card states: "Governing Terms: Use of the model is governed by the NVIDIA Open Model License Agreement (https://www.nvidia.com/en-us/agreements/enterprise-software/nvidia-open-model-license/)."
  - Required Attribution Notice: "Licensed by NVIDIA Corporation under the NVIDIA Open Model License".
- Distribution note: Heavy ASR model weights (~731 MB) are not bundled inside `Sumi.app`. They are loaded outside the application bundle from user local storage (`~/Library/Application Support/Sumi/voice`) or reused read-only from your existing local HuggingFace cache upon user request. The lightweight Silero VAD asset (1.2 MB, MIT license) is bundled self-contained within the application bundle at `models/silero-vad-v6.2-F32.gguf`.

The original repository's MIT license and trademark policy remain unchanged. Sumi uses its own product name and mark. References to upstream names are attribution, not endorsement.
