import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface OcrResult {
  text: string;
  confidence: number | null;
  engine: "tesseract";
}

function normalizeText(raw: string): string {
  return raw.replace(/\s+/g, " ").trim();
}

function parseTsv(tsv: string): OcrResult | null {
  const lines = tsv.trim().split(/\r?\n/);
  if (lines.length <= 1) {
    return null;
  }

  const rows = lines.slice(1);
  const words: string[] = [];
  const confidences: number[] = [];

  for (const row of rows) {
    const cols = row.split("\t");
    if (cols.length < 12) {
      continue;
    }

    const conf = Number.parseFloat(cols[10] || "");
    const text = normalizeText(cols[11] || "");
    if (!text) {
      continue;
    }

    words.push(text);
    if (Number.isFinite(conf) && conf >= 0) {
      confidences.push(conf);
    }
  }

  const normalized = normalizeText(words.join(" "));
  if (!normalized) {
    return null;
  }

  const avgConfidence =
    confidences.length > 0
      ? Number((confidences.reduce((sum, value) => sum + value, 0) / confidences.length / 100).toFixed(2))
      : null;

  return {
    text: normalized,
    confidence: avgConfidence,
    engine: "tesseract",
  };
}

export async function runTesseractOcr(
  imageBuffer: Buffer,
  options: { timeoutMs: number; lang: string },
): Promise<OcrResult | null> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "vision-mcp-ocr-"));
  const imagePath = path.join(tmpDir, "annotation.jpg");

  try {
    await fs.writeFile(imagePath, imageBuffer);

    const { stdout } = await execFileAsync(
      "tesseract",
      [imagePath, "stdout", "--psm", "6", "-l", options.lang, "tsv"],
      {
        timeout: options.timeoutMs,
        maxBuffer: 4 * 1024 * 1024,
      },
    );

    return parseTsv(stdout);
  } catch {
    return null;
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}
