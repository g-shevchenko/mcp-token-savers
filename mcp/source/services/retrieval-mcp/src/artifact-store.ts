import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { RetrievalConfig } from "./config.js";

export interface StoredArtifact {
  fileName: string;
  localPath: string;
  url: string;
}

export function stableKey(prefix: string, input: string): string {
  const digest = createHash("sha256").update(input).digest("hex").slice(0, 20);
  return `${prefix}-${digest}`;
}

function safeExt(rawExt: string): string {
  const normalized = rawExt.replace(/^\.+/, "").toLowerCase();
  return normalized || "txt";
}

export async function ensureArtifactDir(config: RetrievalConfig): Promise<void> {
  await mkdir(config.artifactDir, { recursive: true });
}

export function buildArtifactUrl(config: RetrievalConfig, fileName: string): string {
  return `${config.publicBaseUrl.replace(/\/+$/, "")}/artifacts/${fileName}`;
}

export async function persistArtifactText(
  config: RetrievalConfig,
  key: string,
  ext: string,
  text: string,
): Promise<StoredArtifact> {
  await ensureArtifactDir(config);
  const fileName = `${key}.${safeExt(ext)}`;
  const localPath = path.join(config.artifactDir, fileName);
  await writeFile(localPath, text, "utf8");
  return {
    fileName,
    localPath,
    url: buildArtifactUrl(config, fileName),
  };
}

export async function persistArtifactJson(
  config: RetrievalConfig,
  key: string,
  payload: unknown,
): Promise<StoredArtifact> {
  return persistArtifactText(config, key, "json", JSON.stringify(payload, null, 2));
}

export async function readArtifact(config: RetrievalConfig, fileName: string): Promise<Buffer | null> {
  const localPath = path.join(config.artifactDir, path.basename(fileName));
  try {
    await stat(localPath);
    return await readFile(localPath);
  } catch {
    return null;
  }
}
