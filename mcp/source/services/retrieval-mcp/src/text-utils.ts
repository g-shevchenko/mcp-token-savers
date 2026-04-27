export function clampText(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, Math.max(0, maxChars - 80))}\n\n[...truncated ${text.length - maxChars} chars...]`;
}

export function unique<T>(items: T[]): T[] {
  return Array.from(new Set(items));
}

export function normalizeWhitespace(text: string): string {
  return text.replace(/[ \t]+/g, " ").trim();
}
