export function estimateTokens(text: string): number {
  if (!text) {
    return 0;
  }

  const cyrillicChars = (text.match(/[\u0400-\u04ff]/g) || []).length;
  const otherChars = Math.max(0, text.length - cyrillicChars);
  return Math.max(1, Math.ceil(cyrillicChars / 2.5 + otherChars / 4));
}

export function savingsPct(rawTokens: number, compactTokens: number): number {
  if (rawTokens <= 0) {
    return 0;
  }
  return Math.max(0, Math.round((1 - compactTokens / rawTokens) * 1000) / 10);
}
