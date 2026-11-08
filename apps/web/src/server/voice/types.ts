export interface VoiceStatus {
  ready: boolean;
  cached: boolean;
  activeModel: "parakeet-unified-en-0.6b";
  vadReady: boolean;
  device?: string;
}

export interface SetupResponse {
  ok: boolean;
  device?: string;
  warning?: string;
}

export interface TranscribeResponse {
  text: string;
  speechDurationMs: number;
  latencyMs: number;
  warning?: string;
}
