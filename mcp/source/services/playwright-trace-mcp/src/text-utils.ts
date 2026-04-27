import crypto from "node:crypto";

const SECRET_PATTERNS: RegExp[] = [
  /(sk-[A-Za-z0-9_-]{12,})/g,
  /(xox[baprs]-[A-Za-z0-9-]{10,})/g,
  /(gh[pousr]_[A-Za-z0-9_]{20,})/g,
  /((?:api|secret|token|password|passwd|pwd|key|authorization|cookie)[A-Za-z0-9_.-]*\s*[:=]\s*)[^\s"'`]+/gi,
];

export function redactSecrets(text: string): string {
  return SECRET_PATTERNS.reduce((current, pattern) => current.replace(pattern, "$1[REDACTED]"), text);
}

export function clampText(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, maxChars)}\n...[truncated ${text.length - maxChars} chars]`;
}

export function estimateTokens(text: string): number {
  return text ? Math.ceil(text.length / 4) : 0;
}

export function round(value: number, digits = 1): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export function stableHash(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex").slice(0, 16);
}

export function safePreview(value: unknown, maxChars = 260): string | undefined {
  if (typeof value !== "string" || !value.trim()) {
    return undefined;
  }
  return clampText(redactSecrets(value.trim().replace(/\s+/g, " ")), maxChars);
}

export function safeUrlPreview(value: unknown, maxChars = 160): string | undefined {
  if (typeof value !== "string" || !value.trim()) {
    return undefined;
  }
  const trimmed = value.trim();
  try {
    const url = new URL(trimmed);
    return safePreview(`${url.protocol}//${url.host}${url.pathname}`, maxChars);
  } catch {
    return safePreview(trimmed.split(/[?#]/, 1)[0], maxChars);
  }
}
