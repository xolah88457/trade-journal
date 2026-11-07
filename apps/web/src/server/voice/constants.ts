export const ASR_MODEL = {
  id: "parakeet-unified-en-0.6b" as const,
  repo: "handy-computer/parakeet-unified-en-0.6b-gguf",
  revision: "7e948f21b7bdbac698d3318db9d350f1096f3b6c",
  filename: "parakeet-unified-en-0.6b-Q8_0.gguf",
  size: 731357568,
  sha256: "4b50b6dd862bf6e346929aaf4f5eaacec003bfa3f56462d6c874b41ef2f38795",
  downloadUrl:
    "https://huggingface.co/handy-computer/parakeet-unified-en-0.6b-gguf/resolve/7e948f21b7bdbac698d3318db9d350f1096f3b6c/parakeet-unified-en-0.6b-Q8_0.gguf",
} as const;

export const SILERO_VAD_MODEL = {
  filename: "silero-vad-v6.2-F32.gguf",
  size: 1241056,
  sha256: "0d871a800c420fdd5d1b17a3aea4296d1c39608f0ff4a9295eb76457eb1c88e6",
} as const;

export const AUDIO_CONFIG = {
  sampleRate: 16000,
  frameSamples: 512, // 32 ms at 16 kHz
  maxAudioDurationMs: 5 * 60 * 1000, // 5 minutes max
  maxSamples: 16000 * 5 * 60, // 4,800,000 samples
  maxBytes: 16000 * 5 * 60 * 4, // 19,200,000 bytes (~19.2 MB)
} as const;

export const VAD_CONFIG = {
  threshold: 0.3,
  prefillMs: 450,
  onsetMs: 60,
  hangoverMs: 450,
} as const;

export const CHUNKING_CONFIG = {
  targetSeconds: 30,
  maxChunkSeconds: 40,
  minChunkSeconds: 5,
  maxChunkSamples: 40 * 16000,
  minChunkSamples: 5 * 16000,
} as const;
