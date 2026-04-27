export interface ImageTokenEstimate {
  anthropic_approx: number;
  openai_low_detail: number;
  openai_high_detail_approx: number;
}

export function estimateImageTokens(width: number, height: number): ImageTokenEstimate {
  const safeWidth = Math.max(1, Math.round(width));
  const safeHeight = Math.max(1, Math.round(height));
  const anthropicApprox = Math.ceil((safeWidth * safeHeight) / 750);
  const openaiHighTiles = Math.max(1, Math.ceil(safeWidth / 512) * Math.ceil(safeHeight / 512));

  return {
    anthropic_approx: anthropicApprox,
    openai_low_detail: 85,
    openai_high_detail_approx: 85 + openaiHighTiles * 170,
  };
}
