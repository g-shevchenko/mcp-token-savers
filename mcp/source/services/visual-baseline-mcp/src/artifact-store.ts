import fs from "node:fs/promises";
import path from "node:path";
import { VisualBaselineConfig } from "./config.js";

export async function writeArtifact(
  config: VisualBaselineConfig,
  fileName: string,
  content: string | Buffer,
): Promise<{ file: string; url: string }> {
  await fs.mkdir(config.artifactDir, { recursive: true });
  const safeFile = path.basename(fileName);
  const filePath = path.join(config.artifactDir, safeFile);
  await fs.writeFile(filePath, content);
  return {
    file: safeFile,
    url: `${config.publicBaseUrl}/artifacts/${encodeURIComponent(safeFile)}`,
  };
}

export async function readArtifact(config: VisualBaselineConfig, fileName: string): Promise<Buffer | null> {
  const safeFile = path.basename(fileName);
  try {
    return await fs.readFile(path.join(config.artifactDir, safeFile));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

export function artifactFileName(urlOrFile: string): string {
  try {
    const url = new URL(urlOrFile);
    const parts = url.pathname.split("/").filter(Boolean);
    return decodeURIComponent(parts[parts.length - 1] || urlOrFile);
  } catch {
    return path.basename(urlOrFile);
  }
}
