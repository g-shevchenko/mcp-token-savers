import fs from "node:fs/promises";
import path from "node:path";
import { RepoHygieneConfig } from "./config.js";
import { clampText, stableHash } from "./text-utils.js";

export function artifactFileName(artifactUrlOrFile: string): string {
  const clean = artifactUrlOrFile.replace(/^repo-hygiene:\/\/local\/artifacts\//, "");
  return path.basename(clean);
}

export async function writeJsonArtifact(
  config: RepoHygieneConfig,
  prefix: string,
  payload: unknown,
): Promise<{ artifact_file: string; artifact_url: string }> {
  await fs.mkdir(config.artifactDir, { recursive: true });
  const raw = JSON.stringify(payload, null, 2);
  const file = `${prefix}-${stableHash(raw)}.json`;
  await fs.writeFile(path.join(config.artifactDir, file), `${raw}\n`, "utf8");
  return {
    artifact_file: file,
    artifact_url: `${config.publicBaseUrl}/artifacts/${file}`,
  };
}

export async function readArtifact(
  config: RepoHygieneConfig,
  artifactUrlOrFile: string,
  maxChars = 20_000,
): Promise<{ artifact_file: string; text: string; truncated: boolean }> {
  const artifactFile = artifactFileName(artifactUrlOrFile);
  const resolved = path.join(config.artifactDir, artifactFile);
  const raw = await fs.readFile(resolved, "utf8");
  const clamped = clampText(raw, Math.min(maxChars, config.maxArtifactChars));
  return {
    artifact_file: artifactFile,
    text: clamped,
    truncated: clamped.length < raw.length,
  };
}
