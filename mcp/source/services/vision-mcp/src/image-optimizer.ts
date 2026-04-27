/**
 * Image optimization for VLM processing
 * Reduces image size for faster VLM inference while preserving quality
 */

import sharp from 'sharp';

export interface OptimizeOptions {
  /** Maximum width in pixels (default: 1200) */
  maxWidth?: number;
  /** Maximum height in pixels (default: 800) */
  maxHeight?: number;
  /** JPEG quality 1-100 (default: 85) */
  quality?: number;
  /** Output format (default: 'jpeg') */
  format?: 'jpeg' | 'png' | 'webp';
}

export interface OptimizationResult {
  /** Optimized image buffer */
  buffer: Buffer;
  /** Original size in bytes */
  originalSize: number;
  /** Optimized size in bytes */
  optimizedSize: number;
  /** Compression ratio (0-1) */
  compressionRatio: number;
  /** Original dimensions */
  originalDimensions: { width: number; height: number };
  /** Final dimensions */
  finalDimensions: { width: number; height: number };
  /** Processing time in ms */
  processingTimeMs: number;
}

const DEFAULT_OPTIONS: Required<OptimizeOptions> = {
  maxWidth: 1200,
  maxHeight: 800,
  quality: 85,
  format: 'jpeg',
};

/**
 * Optimize image for VLM processing
 * - Resizes if too large (preserves aspect ratio)
 * - Compresses to JPEG for smaller size
 * - Returns optimization metrics
 */
export async function optimizeForVLM(
  imageBuffer: Buffer,
  options: OptimizeOptions = {}
): Promise<OptimizationResult> {
  const startTime = Date.now();
  const opts = { ...DEFAULT_OPTIONS, ...options };

  // Get original metadata
  const metadata = await sharp(imageBuffer).metadata();
  const originalDimensions = {
    width: metadata.width || 0,
    height: metadata.height || 0,
  };

  let pipeline = sharp(imageBuffer);

  // Resize if dimensions exceed limits
  const needsResize =
    (originalDimensions.width > opts.maxWidth) ||
    (originalDimensions.height > opts.maxHeight);

  if (needsResize) {
    pipeline = pipeline.resize(opts.maxWidth, opts.maxHeight, {
      fit: 'inside',
      withoutEnlargement: true,
    });
  }

  // Apply format and compression
  switch (opts.format) {
    case 'jpeg':
      pipeline = pipeline.jpeg({
        quality: opts.quality,
        progressive: true,
        mozjpeg: true,
      });
      break;
    case 'png':
      pipeline = pipeline.png({
        compressionLevel: 9,
        quality: opts.quality,
      });
      break;
    case 'webp':
      pipeline = pipeline.webp({
        quality: opts.quality,
        effort: 4,
      });
      break;
  }

  // Get optimized buffer
  const optimizedBuffer = await pipeline.toBuffer();

  // Get final dimensions
  const finalMetadata = await sharp(optimizedBuffer).metadata();
  const finalDimensions = {
    width: finalMetadata.width || 0,
    height: finalMetadata.height || 0,
  };

  const processingTimeMs = Date.now() - startTime;

  return {
    buffer: optimizedBuffer,
    originalSize: imageBuffer.length,
    optimizedSize: optimizedBuffer.length,
    compressionRatio: 1 - (optimizedBuffer.length / imageBuffer.length),
    originalDimensions,
    finalDimensions,
    processingTimeMs,
  };
}

/**
 * Quick optimization with default settings
 * For screenshots going to VLM
 */
export async function optimizeScreenshot(imageBuffer: Buffer): Promise<Buffer> {
  const result = await optimizeForVLM(imageBuffer, {
    maxWidth: 1200,
    maxHeight: 800,
    quality: 85,
    format: 'jpeg',
  });

  console.error(
    `[ImageOptimizer] ${result.originalSize} → ${result.optimizedSize} bytes ` +
    `(${(result.compressionRatio * 100).toFixed(1)}% saved, ` +
    `${result.processingTimeMs}ms)`
  );

  // Return as plain Buffer to avoid type issues
  return Buffer.from(result.buffer);
}

/**
 * Check if image needs optimization
 */
export function shouldOptimize(
  sizeBytes: number,
  maxSizeBytes: number = 500 * 1024 // 500KB
): boolean {
  return sizeBytes > maxSizeBytes;
}
