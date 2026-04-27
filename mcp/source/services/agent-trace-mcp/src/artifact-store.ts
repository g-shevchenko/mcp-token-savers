import fs from "node:fs/promises";
import path from "node:path";
import { AgentTraceConfig } from "./config.js";
import { redactSecrets } from "./text-utils.js";

export function artifactFileName(raw: string): string {
  const cleaned = raw.replace(/^agent-trace:\/\/local\/artifacts\//, "");
  return path.basename(cleaned);
}

export async function writeArtifact(
  config: AgentTraceConfig,
  fileName: string,
  content: string | Buffer,
): Promise<{ file: string; url: string }> {
  await fs.mkdir(config.artifactDir, { recursive: true });
  const safeName = path.basename(fileName);
  const fullPath = path.join(config.artifactDir, safeName);
  await fs.writeFile(fullPath, content);
  return {
    file: safeName,
    url: `${config.publicBaseUrl}/artifacts/${safeName}`,
  };
}

export async function readArtifact(config: AgentTraceConfig, fileName: string): Promise<Buffer | null> {
  const safeName = path.basename(fileName);
  const fullPath = path.join(config.artifactDir, safeName);
  try {
    return await fs.readFile(fullPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw new Error(redactSecrets(error instanceof Error ? error.message : String(error)));
  }
}
