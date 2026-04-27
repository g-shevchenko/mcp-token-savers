import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { VisionRuntimeConfig } from "./config.js";

export interface StoredArtifact {
  fileName: string;
  localPath: string;
  url: string;
}

function safeExt(rawExt: string): string {
  const normalized = rawExt.replace(/^\.+/, "").toLowerCase();
  return normalized || "bin";
}

export function artifactDir(config: VisionRuntimeConfig): string {
  return config.artifactDir;
}

export async function ensureArtifactDir(config: VisionRuntimeConfig): Promise<void> {
  await mkdir(config.artifactDir, { recursive: true });
}

export function buildArtifactUrl(config: VisionRuntimeConfig, fileName: string): string {
  return `${config.publicBaseUrl.replace(/\/+$/, "")}/artifacts/${fileName}`;
}

export async function persistArtifactBuffer(
  config: VisionRuntimeConfig,
  key: string,
  ext: string,
  buffer: Buffer,
): Promise<StoredArtifact> {
  await ensureArtifactDir(config);

  const fileName = `${key}.${safeExt(ext)}`;
  const localPath = path.join(config.artifactDir, fileName);

  try {
    const current = await readFile(localPath);
    if (current.equals(buffer)) {
      return {
        fileName,
        localPath,
        url: buildArtifactUrl(config, fileName),
      };
    }
  } catch {
    // Ignore cache miss and write below.
  }

  await writeFile(localPath, buffer);

  return {
    fileName,
    localPath,
    url: buildArtifactUrl(config, fileName),
  };
}

export async function persistArtifactJson(
  config: VisionRuntimeConfig,
  key: string,
  payload: unknown,
): Promise<StoredArtifact> {
  const body = Buffer.from(JSON.stringify(payload, null, 2), "utf8");
  return persistArtifactBuffer(config, key, "json", body);
}

export async function readArtifact(config: VisionRuntimeConfig, fileName: string): Promise<Buffer | null> {
  const localPath = path.join(config.artifactDir, path.basename(fileName));

  try {
    await stat(localPath);
    return await readFile(localPath);
  } catch {
    return null;
  }
}
