import { createHash } from "node:crypto";

export function stableHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

export function estimateTokens(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.ceil(Math.max(0, value) / 4);
  }
  const text = typeof value === "string" ? value : JSON.stringify(value ?? "");
  return Math.ceil(text.length / 4);
}

export function round(value: number, digits = 1): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export function cleanLabel(value: unknown, fallback = "unknown"): string {
  if (typeof value !== "string" || !value.trim()) {
    return fallback;
  }
  return value.trim().toLowerCase().replace(/[^a-z0-9_.:-]+/g, "-").slice(0, 80) || fallback;
}
