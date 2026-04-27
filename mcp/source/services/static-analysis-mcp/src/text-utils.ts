export function clampText(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, Math.max(0, maxChars - 24))}\n...[truncated]`;
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function redactSecrets(text: string): string {
  return text
    .replace(/(sk_[A-Za-z0-9_-]{6})[A-Za-z0-9_-]+/g, "$1***")
    .replace(/(gh[opsu]_[A-Za-z0-9_-]{6})[A-Za-z0-9_-]+/g, "$1***")
    .replace(/([A-Za-z0-9_]*TOKEN[A-Za-z0-9_]*=)[^\s]+/gi, "$1***")
    .replace(/([A-Za-z0-9_]*KEY[A-Za-z0-9_]*=)[^\s]+/gi, "$1***")
    .replace(/([A-Za-z0-9_]*SECRET[A-Za-z0-9_]*=)[^\s]+/gi, "$1***");
}

export function tokenStats(raw: string, compact: string) {
  const rawTokens = estimateTokens(raw);
  const compactTokens = estimateTokens(compact);
  const savedTokens = Math.max(0, rawTokens - compactTokens);
  return {
    raw_tokens_estimate: rawTokens,
    compact_tokens_estimate: compactTokens,
    saved_tokens_estimate: savedTokens,
    savings_pct: rawTokens > 0 ? Math.round((savedTokens / rawTokens) * 1000) / 10 : 0,
  };
}
