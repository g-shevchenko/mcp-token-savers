export interface TokenStats {
  raw_chars: number;
  compact_chars: number;
  raw_tokens_estimate: number;
  compact_tokens_estimate: number;
  saved_tokens_estimate: number;
  savings_pct: number;
}

export function estimateTokens(text: string): number {
  if (!text) {
    return 0;
  }

  const cyrillicChars = (text.match(/[А-Яа-яЁё]/g) || []).length;
  const divisor = cyrillicChars > text.length * 0.25 ? 3.2 : 4;
  return Math.max(1, Math.ceil(text.length / divisor));
}

export function buildTokenStats(raw: string, compact: string): TokenStats {
  const rawTokens = estimateTokens(raw);
  const compactTokens = estimateTokens(compact);
  const saved = Math.max(0, rawTokens - compactTokens);

  return {
    raw_chars: raw.length,
    compact_chars: compact.length,
    raw_tokens_estimate: rawTokens,
    compact_tokens_estimate: compactTokens,
    saved_tokens_estimate: saved,
    savings_pct: rawTokens > 0 ? Number(((saved / rawTokens) * 100).toFixed(1)) : 0,
  };
}
