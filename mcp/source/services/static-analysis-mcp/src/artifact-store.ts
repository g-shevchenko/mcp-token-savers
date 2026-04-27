import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { StaticAnalysisConfig } from "./config.js";

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
  return rawExt.replace(/^\.+/, "").toLowerCase() || "txt";
}

export function artifactFileName(raw: string): string {
  try {
    const parsed = new URL(raw);
    return path.basename(parsed.pathname);
  } catch {
    return path.basename(raw);
  }
}

export function artifactUrl(config: StaticAnalysisConfig, fileName: string): string {
  return `${config.publicBaseUrl}/artifacts/${fileName}`;
}

export async function persistArtifactText(
  config: StaticAnalysisConfig,
  key: string,
  ext: string,
  text: string,
): Promise<StoredArtifact> {
  await mkdir(config.artifactDir, { recursive: true });
  const fileName = `${key}.${safeExt(ext)}`;
  const localPath = path.join(config.artifactDir, fileName);
  await writeFile(localPath, text, "utf8");
  return {
    fileName,
    localPath,
    url: artifactUrl(config, fileName),
  };
}

export async function persistArtifactJson(
  config: StaticAnalysisConfig,
  key: string,
  payload: unknown,
): Promise<StoredArtifact> {
  return persistArtifactText(config, key, "json", JSON.stringify(payload, null, 2));
}

export async function readArtifact(config: StaticAnalysisConfig, fileName: string): Promise<Buffer | null> {
  const localPath = path.join(config.artifactDir, path.basename(fileName));
  try {
    await stat(localPath);
    return await readFile(localPath);
  } catch {
    return null;
  }
}
