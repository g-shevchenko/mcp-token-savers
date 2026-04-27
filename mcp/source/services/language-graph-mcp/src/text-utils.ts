import crypto from "node:crypto";

const SECRET_PATTERNS: RegExp[] = [
  /sk-[A-Za-z0-9_-]{20,}/g,
  /ghp_[A-Za-z0-9_]{20,}/g,
  /xox[baprs]-[A-Za-z0-9-]{20,}/g,
  /AIza[0-9A-Za-z_-]{20,}/g,
  /(?<=(api[_-]?key|token|secret|password)\s*[:=]\s*)["']?[^"'\s,}]{8,}/gi,
];

export function redactSecrets(input: string): string {
  let output = input;
  for (const pattern of SECRET_PATTERNS) {
    output = output.replace(pattern, "[REDACTED]");
  }
  return output;
}

export function stableHash(input: string): string {
  return crypto.createHash("sha256").update(input).digest("hex").slice(0, 16);
}

export function clampText(input: string, maxChars: number): string {
  if (input.length <= maxChars) {
    return input;
  }
  return `${input.slice(0, Math.max(0, maxChars - 80))}\n...[truncated ${input.length - maxChars} chars]`;
}

export function round(value: number, digits = 1): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export function estimateTokens(input: string): number {
  return Math.ceil(input.length / 4);
}

export function normalizePathForGraph(input: string): string {
  return input.replace(/\\/g, "/").replace(/^\.\/+/, "").replace(/\/+/g, "/");
}

export function basenameWithoutExt(input: string): string {
  const clean = normalizePathForGraph(input).split("/").pop() || input;
  return clean.replace(/\.[^.]+$/, "");
}
