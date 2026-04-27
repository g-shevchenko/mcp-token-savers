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

export function redactSensitive(value: string): string {
  const home = process.env.HOME?.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  let redacted = value
    .replace(/(api[_-]?key|token|secret|password|authorization)(["'\s:=]+)[^"'\s]+/gi, "$1$2[redacted]")
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [redacted]")
    .replace(/\/Users\/[^"'\s]+/g, "[local-path]");
  if (home) {
    redacted = redacted.replace(new RegExp(home, "g"), "[home]");
  }
  return redacted;
}
