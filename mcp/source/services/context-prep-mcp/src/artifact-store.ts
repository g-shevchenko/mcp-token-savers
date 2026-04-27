import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { ContextPrepConfig } from "./config.js";

export interface StoredArtifact {
  fileName: string;
  localPath: string;
  url: string;
}

function safeExt(rawExt: string): string {
  const normalized = rawExt.replace(/^\.+/, "").toLowerCase();
  return normalized || "txt";
}

export function stableKey(prefix: string, input: string): string {
  const digest = createHash("sha256").update(input).digest("hex").slice(0, 20);
  return `${prefix}-${digest}`;
}

export async function ensureArtifactDir(config: ContextPrepConfig): Promise<void> {
  await mkdir(config.artifactDir, { recursive: true });
}

export function buildArtifactUrl(config: ContextPrepConfig, fileName: string): string {
  return `${config.publicBaseUrl.replace(/\/+$/, "")}/artifacts/${fileName}`;
}

export async function persistArtifactBuffer(
  config: ContextPrepConfig,
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
    // Cache miss: write below.
  }

  await writeFile(localPath, buffer);

  return {
    fileName,
    localPath,
    url: buildArtifactUrl(config, fileName),
  };
}

export async function persistArtifactText(
  config: ContextPrepConfig,
  key: string,
  ext: string,
  text: string,
): Promise<StoredArtifact> {
  return persistArtifactBuffer(config, key, ext, Buffer.from(text, "utf8"));
}

export async function persistArtifactJson(
  config: ContextPrepConfig,
  key: string,
  payload: unknown,
): Promise<StoredArtifact> {
  return persistArtifactText(config, key, "json", JSON.stringify(payload, null, 2));
}

export async function readArtifact(config: ContextPrepConfig, fileName: string): Promise<Buffer | null> {
  const localPath = path.join(config.artifactDir, path.basename(fileName));

  try {
    await stat(localPath);
    return await readFile(localPath);
  } catch {
    return null;
  }
}
