/**
 * Batch analyzer for multiple screenshots
 * Parallel download, optimization, and sequential VLM analysis
 */

import fetch from "node-fetch";
import { optimizeScreenshot } from "./image-optimizer.js";
import { analyzeScreenshotWithVLM, ScreenshotAnalysis } from "./vlm-analyzer.js";

export interface BatchAnalysisRequest {
  urls: string[];
  context?: string;
}

export interface BatchAnalysisResult {
  url: string;
  analysis: ScreenshotAnalysis;
  processingTimeMs: number;
  optimizedSize?: number;
  originalSize?: number;
}

export interface BatchAnalysisSummary {
  results: BatchAnalysisResult[];
  totalTimeMs: number;
  totalImages: number;
  totalAnnotations: number;
}

/**
 * Download image from URL
 */
async function downloadImage(url: string): Promise<{ buffer: Buffer; size: number }> {
  const response = await fetch(url, {
    headers: { "User-Agent": "HWAI-Vision-MCP/1.0" },
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${url}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(new Uint8Array(arrayBuffer));

  return { buffer, size: buffer.length };
}

/**
 * Process single screenshot: download + optimize + analyze
 */
async function processScreenshot(
  url: string,
  context?: string
): Promise<BatchAnalysisResult> {
  const startTime = Date.now();

  try {
    // Step 1: Download
    console.error(`[Batch] Downloading: ${url}`);
    const { buffer: rawBuffer, size: originalSize } = await downloadImage(url);

    // Step 2: Optimize
    console.error(`[Batch] Optimizing: ${url} (${originalSize} bytes)`);
    const optimizedBuffer = await optimizeScreenshot(rawBuffer);
    const optimizedSize = optimizedBuffer.length;

    // Step 3: Analyze with VLM
    console.error(`[Batch] Analyzing: ${url}`);
    const base64 = optimizedBuffer.toString("base64");
    const analysis = await analyzeScreenshotWithVLM(base64, {
      model: "qwen3-vl:latest",
      maxTokens: 600, // Shorter for speed
      temperature: 0.2,
    });

    const processingTimeMs = Date.now() - startTime;

    return {
      url,
      analysis,
      processingTimeMs,
      optimizedSize,
      originalSize,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`[Batch] Error processing ${url}: ${errorMessage}`);

    return {
      url,
      analysis: {
        schema_version: "vision-mcp.v2",
        analysis_scope: "full_frame",
        annotations: [],
        ui_objects: [],
        annotation_objects: [],
        links: [],
        ui_summary: `Error: ${errorMessage}`,
      },
      processingTimeMs: Date.now() - startTime,
    };
  }
}

/**
 * Analyze multiple screenshots in parallel
 * Downloads and optimizations happen in parallel
 * VLM analysis happens sequentially to avoid overloading
 */
export async function analyzeBatch(
  urls: string[],
  context?: string
): Promise<BatchAnalysisSummary> {
  const totalStartTime = Date.now();

  console.error(`[Batch] Starting analysis of ${urls.length} screenshots...`);

  // Phase 1: Download all images in parallel
  console.error(`[Batch] Phase 1: Downloading ${urls.length} images in parallel...`);
  const downloadStart = Date.now();

  const downloadPromises = urls.map(async (url) => {
    try {
      const { buffer, size } = await downloadImage(url);
      return { url, buffer, size, success: true };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return { url, buffer: null, size: 0, success: false, error: msg };
    }
  });

  const downloadResults = await Promise.all(downloadPromises);
  const downloadTime = Date.now() - downloadStart;
  const totalDownloaded = downloadResults.reduce((sum, r) => sum + (r.size || 0), 0);

  console.error(
    `[Batch] Downloaded ${downloadResults.filter(r => r.success).length}/${urls.length} ` +
    `images in ${downloadTime}ms (${(totalDownloaded / 1024 / 1024).toFixed(1)} MB total)`
  );

  // Phase 2: Optimize all images in parallel
  console.error(`[Batch] Phase 2: Optimizing images in parallel...`);
  const optimizeStart = Date.now();

  const optimizePromises = downloadResults
    .filter(r => r.success && r.buffer)
    .map(async (result) => {
      try {
        const optimized = await optimizeScreenshot(result.buffer!);
        return {
          url: result.url,
          originalBuffer: result.buffer,
          optimizedBuffer: optimized,
          originalSize: result.size,
          optimizedSize: optimized.length,
          success: true,
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return {
          url: result.url,
          originalBuffer: result.buffer,
          optimizedBuffer: result.buffer, // Fallback to original
          originalSize: result.size,
          optimizedSize: result.size,
          success: false,
          error: msg,
        };
      }
    });

  const optimizeResults = await Promise.all(optimizePromises);
  const optimizeTime = Date.now() - optimizeStart;

  const totalOptimized = optimizeResults.reduce((sum, r) => sum + r.optimizedSize, 0);
  const savings = ((1 - totalOptimized / totalDownloaded) * 100).toFixed(1);

  console.error(
    `[Batch] Optimized ${optimizeResults.length} images in ${optimizeTime}ms ` +
    `(${savings}% saved, ${(totalOptimized / 1024).toFixed(0)} KB total)`
  );

  // Phase 3: VLM analysis (sequential to avoid overloading)
  console.error(`[Batch] Phase 3: VLM analysis (sequential)...`);
  const results: BatchAnalysisResult[] = [];

  for (let i = 0; i < optimizeResults.length; i++) {
    const item = optimizeResults[i];
    const vlmStart = Date.now();

    console.error(`[Batch] [${i + 1}/${optimizeResults.length}] Analyzing ${item.url}...`);

    if (!item.optimizedBuffer) {
      results.push({
        url: item.url,
        analysis: {
          schema_version: "vision-mcp.v2",
          analysis_scope: "full_frame",
          annotations: [],
          ui_objects: [],
          annotation_objects: [],
          links: [],
          ui_summary: "Optimization failed: no buffer",
        },
        processingTimeMs: Date.now() - vlmStart,
        originalSize: item.originalSize,
        optimizedSize: 0,
      });
      continue;
    }

    try {
      const base64 = Buffer.from(item.optimizedBuffer).toString("base64");
      const analysis = await analyzeScreenshotWithVLM(base64, {
        model: "qwen3-vl:latest",
        // No maxTokens limit - Qwen3-VL works better without it
        temperature: 0.2,
      });

      results.push({
        url: item.url,
        analysis,
        processingTimeMs: Date.now() - vlmStart,
        originalSize: item.originalSize,
        optimizedSize: item.optimizedSize,
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      results.push({
        url: item.url,
        analysis: {
          schema_version: "vision-mcp.v2",
          analysis_scope: "full_frame",
          annotations: [],
          ui_objects: [],
          annotation_objects: [],
          links: [],
          ui_summary: `VLM Error: ${msg}`,
        },
        processingTimeMs: Date.now() - vlmStart,
        originalSize: item.originalSize,
        optimizedSize: item.optimizedSize,
      });
    }
  }

  // Handle failed downloads
  for (const result of downloadResults.filter(r => !r.success)) {
    results.push({
      url: result.url,
      analysis: {
        schema_version: "vision-mcp.v2",
        analysis_scope: "full_frame",
        annotations: [],
        ui_objects: [],
        annotation_objects: [],
        links: [],
        ui_summary: `Download failed: ${result.error}`,
      },
      processingTimeMs: 0,
    });
  }

  const totalTimeMs = Date.now() - totalStartTime;
  const totalAnnotations = results.reduce(
    (sum, r) => sum + r.analysis.annotations.length,
    0
  );

  console.error(
    `[Batch] Completed ${urls.length} screenshots ` +
    `(${totalAnnotations} annotations) in ${totalTimeMs}ms`
  );

  return {
    results,
    totalTimeMs,
    totalImages: urls.length,
    totalAnnotations,
  };
}
