import crypto from "node:crypto";

export function stableHash(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex").slice(0, 16);
}

export function clampText(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  return `${value.slice(0, Math.max(0, maxChars - 80))}\n\n[truncated ${value.length - maxChars} chars]`;
}

export function estimateTokens(value: string | number): number {
  const chars = typeof value === "number" ? value : value.length;
  return Math.max(0, Math.ceil(chars / 4));
}

export function round(value: number, digits = 1): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export function redactSecrets(value: string): string {
  return value
    .replace(/(api[_-]?key|token|secret|password|authorization)(["'\s:=]+)[^"'\s]+/gi, "$1$2[redacted]")
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [redacted]");
}

export function githubSlug(heading: string, seen?: Map<string, number>): string {
  const base = heading
    .trim()
    .toLowerCase()
    .replace(/<[^>]+>/g, "")
    .replace(/[`*_~[\]()]/g, "")
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  if (!seen) {
    return base;
  }
  const count = seen.get(base) || 0;
  seen.set(base, count + 1);
  return count === 0 ? base : `${base}-${count}`;
}
