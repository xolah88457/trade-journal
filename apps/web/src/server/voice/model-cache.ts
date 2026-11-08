import { createHash } from "node:crypto";
import {
  copyFileSync,
  createReadStream,
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { ASR_MODEL, SILERO_VAD_MODEL } from "./constants";

// Cache verified file paths in-memory to avoid rehashing 731MB on every request.
const verifiedHashes = new Map<string, { mtimeMs: number; size: number; sha256: string }>();

export function getJournalDataDir(): string {
  if (process.env.JOURNAL_DATA_DIR) {
    return process.env.JOURNAL_DATA_DIR;
  }
  if (process.platform === "darwin") {
    return join(homedir(), "Library/Application Support/Sumi");
  }
  return join(process.cwd(), "data");
}

export function getVoiceDir(): string {
  return join(getJournalDataDir(), "voice");
}

export async function computeFileSha256(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
    stream.on("error", (err) => reject(err));
  });
}

export async function verifyFileIntegrity(
  filePath: string,
  expectedSize: number,
  expectedSha256: string,
): Promise<boolean> {
  if (!existsSync(filePath)) return false;
  try {
    const stats = statSync(filePath);
    if (stats.size !== expectedSize) return false;

    const cached = verifiedHashes.get(filePath);
    if (cached && cached.mtimeMs === stats.mtimeMs && cached.size === stats.size) {
      return cached.sha256 === expectedSha256;
    }

    const sha256 = await computeFileSha256(filePath);
    if (sha256 === expectedSha256) {
      verifiedHashes.set(filePath, {
        mtimeMs: stats.mtimeMs,
        size: stats.size,
        sha256,
      });
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Checks for Parakeet Unified EN 0.6B weights:
 * 1. Pi Voice HuggingFace cache (read-only, never delete or mutate)
 * 2. JOURNAL_DATA_DIR/voice (outside .app)
 * Returns the resolved path or null if not cached/verified.
 */
export async function resolveAsrModelPath(): Promise<string | null> {
  // 1. Check existing Pi Voice HuggingFace cache read-only
  const hfCachePath = join(
    homedir(),
    ".cache/huggingface/hub",
    `models--${ASR_MODEL.repo.replace("/", "--")}`,
    "snapshots",
    ASR_MODEL.revision,
    ASR_MODEL.filename,
  );

  if (await verifyFileIntegrity(hfCachePath, ASR_MODEL.size, ASR_MODEL.sha256)) {
    return hfCachePath;
  }

  // 2. Check JOURNAL_DATA_DIR/voice/
  const localVoicePath = join(getVoiceDir(), ASR_MODEL.filename);
  if (await verifyFileIntegrity(localVoicePath, ASR_MODEL.size, ASR_MODEL.sha256)) {
    return localVoicePath;
  }

  return null;
}

/**
 * Checks for Silero VAD weights:
 * 1. JOURNAL_DATA_DIR/voice/silero-vad-v6.2-F32.gguf
 * 2. models/silero-vad-v6.2-F32.gguf in the repo root (the single bundled copy;
 *    found from the repo root, apps/web or the packaged server layout)
 * 3. Fallback to installed Pi Voice models directory
 * Returns the resolved path or null if missing/corrupt.
 */
export async function resolveVadModelPath(): Promise<string | null> {
  const localVoicePath = join(getVoiceDir(), SILERO_VAD_MODEL.filename);
  if (await verifyFileIntegrity(localVoicePath, SILERO_VAD_MODEL.size, SILERO_VAD_MODEL.sha256)) {
    return localVoicePath;
  }

  const repoCandidates = [
    join(process.cwd(), "models", SILERO_VAD_MODEL.filename),
    join(process.cwd(), "..", "models", SILERO_VAD_MODEL.filename),
    join(process.cwd(), "../..", "models", SILERO_VAD_MODEL.filename),
    join(
      homedir(),
      ".pi/agent/npm/node_modules/@earendil-works/pi-voice/models",
      SILERO_VAD_MODEL.filename,
    ),
  ];

  for (const candidate of repoCandidates) {
    if (await verifyFileIntegrity(candidate, SILERO_VAD_MODEL.size, SILERO_VAD_MODEL.sha256)) {
      // Ensure it is copied to voice dir if data dir exists
      try {
        const voiceDir = getVoiceDir();
        mkdirSync(voiceDir, { recursive: true });
        if (!existsSync(localVoicePath)) {
          copyFileSync(candidate, localVoicePath);
          if (
            await verifyFileIntegrity(
              localVoicePath,
              SILERO_VAD_MODEL.size,
              SILERO_VAD_MODEL.sha256,
            )
          ) {
            return localVoicePath;
          }
        }
      } catch {
        // Fall back to reading candidate directly
      }
      return candidate;
    }
  }

  return null;
}

export async function isAsrCached(): Promise<boolean> {
  const path = await resolveAsrModelPath();
  return path !== null;
}

export async function isVadReady(): Promise<boolean> {
  const path = await resolveVadModelPath();
  return path !== null;
}

/**
 * Downloads Parakeet model weights with streaming SHA256 and size verification,
 * writing to a temp file first and atomically renaming to JOURNAL_DATA_DIR/voice.
 * Never accepts client filepaths or model URLs.
 */
export async function downloadAsrModel(signal?: AbortSignal): Promise<string> {
  const existing = await resolveAsrModelPath();
  if (existing) return existing;

  const voiceDir = getVoiceDir();
  mkdirSync(voiceDir, { recursive: true });

  const targetPath = join(voiceDir, ASR_MODEL.filename);
  const tempPath = join(
    voiceDir,
    `.download-${Date.now()}-${Math.random().toString(36).slice(2)}.part`,
  );

  const timeoutSignal = AbortSignal.timeout(600_000); // 10 minutes timeout
  const combinedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;

  const response = await fetch(ASR_MODEL.downloadUrl, {
    method: "GET",
    signal: combinedSignal,
    headers: { "User-Agent": "Sumi/0.1.0" },
  });

  if (!response.ok || !response.body) {
    throw new Error(`Failed to download model weights: HTTP ${response.status}`);
  }

  const hash = createHash("sha256");
  let receivedBytes = 0;

  try {
    const { createWriteStream } = await import("node:fs");
    const writeStream = createWriteStream(tempPath);

    // Stream response body to disk and compute hash simultaneously
    const readable = Readable.fromWeb(response.body as any);

    await new Promise<void>((resolve, reject) => {
      readable.on("data", (chunk: Buffer) => {
        receivedBytes += chunk.length;
        hash.update(chunk);
      });
      readable.pipe(writeStream);
      writeStream.on("finish", () => resolve());
      writeStream.on("error", (err) => reject(err));
      readable.on("error", (err) => reject(err));
    });

    if (receivedBytes !== ASR_MODEL.size) {
      throw new Error(
        `Downloaded model size mismatch: expected ${ASR_MODEL.size}, got ${receivedBytes}`,
      );
    }

    const digest = hash.digest("hex");
    if (digest !== ASR_MODEL.sha256) {
      throw new Error(
        `Downloaded model hash mismatch: expected ${ASR_MODEL.sha256}, got ${digest}`,
      );
    }

    renameSync(tempPath, targetPath);
    verifiedHashes.set(targetPath, {
      mtimeMs: statSync(targetPath).mtimeMs,
      size: receivedBytes,
      sha256: digest,
    });

    return targetPath;
  } catch (err) {
    rmSync(tempPath, { force: true });
    throw err;
  }
}
