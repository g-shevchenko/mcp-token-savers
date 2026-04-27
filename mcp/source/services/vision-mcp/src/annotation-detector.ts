import sharp from "sharp";

export interface BoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DetectedAnnotationRegion extends BoundingBox {
  id: number;
  red_pixel_ratio: number;
  red_pixel_count: number;
  coverage_ratio: number;
  region_type: AnnotationRegionType;
  region_type_confidence: number;
}

export type AnnotationRegionType =
  | "comment_box"
  | "outline"
  | "marker_dot"
  | "underline"
  | "arrow"
  | "unknown";

interface ComponentBox extends BoundingBox {
  red_pixel_count: number;
}

const INSPECTION_MAX_DIMENSION = 960;
const MAX_REGIONS = 8;
const NEARBY_GAP_PX = 18;
const TOP_CORNER_CHROME_INSET_PX = 72;
const SIDE_CHROME_INSET_PX = 64;
const BOTTOM_CHROME_INSET_PX = 112;
const SMALL_EDGE_REGION_MAX_DIMENSION_PX = 72;
const SMALL_EDGE_REGION_MAX_AREA_PX = 2600;
const SMALL_EDGE_REGION_MAX_RED_PIXELS = 700;
const TOP_CHROME_CLUSTER_MIN_COUNT = 3;

function isRedPixel(r: number, g: number, b: number): boolean {
  return (
    r >= 150 &&
    r > g + 45 &&
    r > b + 45 &&
    r > g * 1.2 &&
    r > b * 1.2
  );
}

function overlapsOrNear(a: BoundingBox, b: BoundingBox): boolean {
  return !(
    a.x + a.width + NEARBY_GAP_PX < b.x ||
    b.x + b.width + NEARBY_GAP_PX < a.x ||
    a.y + a.height + NEARBY_GAP_PX < b.y ||
    b.y + b.height + NEARBY_GAP_PX < a.y
  );
}

function unionBoxes(a: ComponentBox, b: ComponentBox): ComponentBox {
  const x1 = Math.min(a.x, b.x);
  const y1 = Math.min(a.y, b.y);
  const x2 = Math.max(a.x + a.width, b.x + b.width);
  const y2 = Math.max(a.y + a.height, b.y + b.height);

  return {
    x: x1,
    y: y1,
    width: x2 - x1,
    height: y2 - y1,
    red_pixel_count: a.red_pixel_count + b.red_pixel_count,
  };
}

function mergeNearbyBoxes(boxes: ComponentBox[]): ComponentBox[] {
  const merged: ComponentBox[] = [];

  for (const box of boxes) {
    let targetIndex = -1;
    for (let i = 0; i < merged.length; i += 1) {
      if (overlapsOrNear(merged[i], box)) {
        targetIndex = i;
        break;
      }
    }

    if (targetIndex === -1) {
      merged.push(box);
      continue;
    }

    merged[targetIndex] = unionBoxes(merged[targetIndex], box);

    let collapsed = true;
    while (collapsed) {
      collapsed = false;
      for (let i = 0; i < merged.length; i += 1) {
        if (i === targetIndex) {
          continue;
        }

        if (overlapsOrNear(merged[targetIndex], merged[i])) {
          merged[targetIndex] = unionBoxes(merged[targetIndex], merged[i]);
          merged.splice(i, 1);
          if (i < targetIndex) {
            targetIndex -= 1;
          }
          collapsed = true;
          break;
        }
      }
    }
  }

  return merged;
}

function clampBox(box: BoundingBox, width: number, height: number): BoundingBox {
  const x = Math.max(0, Math.min(width - 1, Math.round(box.x)));
  const y = Math.max(0, Math.min(height - 1, Math.round(box.y)));
  const right = Math.max(x + 1, Math.min(width, Math.round(box.x + box.width)));
  const bottom = Math.max(y + 1, Math.min(height, Math.round(box.y + box.height)));

  return {
    x,
    y,
    width: Math.max(1, right - x),
    height: Math.max(1, bottom - y),
  };
}

function classifyRegionType(box: ComponentBox, redPixelRatio: number): {
  region_type: AnnotationRegionType;
  region_type_confidence: number;
} {
  const aspectRatio = box.width / Math.max(1, box.height);
  const maxDimension = Math.max(box.width, box.height);
  const area = box.width * box.height;

  if (box.width >= 140 && box.height >= 36 && redPixelRatio >= 0.12) {
    return { region_type: "comment_box", region_type_confidence: 0.83 };
  }

  if (redPixelRatio <= 0.08 && area >= 20000) {
    return { region_type: "outline", region_type_confidence: 0.79 };
  }

  if (maxDimension <= 60 && aspectRatio >= 0.65 && aspectRatio <= 1.6 && redPixelRatio >= 0.12) {
    return { region_type: "marker_dot", region_type_confidence: 0.78 };
  }

  if (aspectRatio >= 4 && box.height <= 32) {
    return { region_type: "underline", region_type_confidence: 0.7 };
  }

  if (aspectRatio >= 1.8 && maxDimension <= 140 && redPixelRatio <= 0.22) {
    return { region_type: "arrow", region_type_confidence: 0.58 };
  }

  return { region_type: "unknown", region_type_confidence: 0.45 };
}

function isCompactEdgeRegion(box: ComponentBox): boolean {
  const area = box.width * box.height;
  const maxDimension = Math.max(box.width, box.height);

  return (
    area <= SMALL_EDGE_REGION_MAX_AREA_PX &&
    maxDimension <= SMALL_EDGE_REGION_MAX_DIMENSION_PX &&
    box.red_pixel_count <= SMALL_EDGE_REGION_MAX_RED_PIXELS
  );
}

function isLikelyBottomDockArtifact(
  box: ComponentBox,
  imageWidth: number,
  imageHeight: number,
): boolean {
  void imageWidth;
  if (!isCompactEdgeRegion(box)) {
    return false;
  }

  const nearBottom = box.y + box.height >= imageHeight - BOTTOM_CHROME_INSET_PX;
  return nearBottom;
}

function isLikelyTopCornerChromeArtifact(
  box: ComponentBox,
  imageWidth: number,
): boolean {
  if (!isCompactEdgeRegion(box)) {
    return false;
  }

  const nearLeft = box.x <= SIDE_CHROME_INSET_PX;
  const nearRight = box.x + box.width >= imageWidth - SIDE_CHROME_INSET_PX;
  const nearTop = box.y <= TOP_CORNER_CHROME_INSET_PX;

  return nearTop && (nearLeft || nearRight);
}

function isLikelyTopChromeClusterCandidate(box: ComponentBox): boolean {
  if (!isCompactEdgeRegion(box)) {
    return false;
  }

  return box.y <= TOP_CORNER_CHROME_INSET_PX && box.height <= 24;
}

export async function detectAnnotationRegions(
  imageBuffer: Buffer,
): Promise<DetectedAnnotationRegion[]> {
  const base = sharp(imageBuffer);
  const metadata = await base.metadata();
  const originalWidth = metadata.width || 0;
  const originalHeight = metadata.height || 0;

  if (!originalWidth || !originalHeight) {
    return [];
  }

  const resized = await base
    .resize({
      width: INSPECTION_MAX_DIMENSION,
      height: INSPECTION_MAX_DIMENSION,
      fit: "inside",
      withoutEnlargement: true,
    })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const inspectWidth = resized.info.width;
  const inspectHeight = resized.info.height;
  const channels = resized.info.channels;
  const raw = resized.data;
  const totalPixels = inspectWidth * inspectHeight;

  if (!inspectWidth || !inspectHeight || channels < 3 || totalPixels === 0) {
    return [];
  }

  const mask = new Uint8Array(totalPixels);
  let redPixels = 0;

  for (let idx = 0; idx < totalPixels; idx += 1) {
    const offset = idx * channels;
    const r = raw[offset];
    const g = raw[offset + 1];
    const b = raw[offset + 2];
    if (isRedPixel(r, g, b)) {
      mask[idx] = 1;
      redPixels += 1;
    }
  }

  if (redPixels === 0) {
    return [];
  }

  const visited = new Uint8Array(totalPixels);
  const minPixels = Math.max(24, Math.round(totalPixels * 0.00006));
  const components: ComponentBox[] = [];
  const queue = new Uint32Array(totalPixels);

  for (let idx = 0; idx < totalPixels; idx += 1) {
    if (!mask[idx] || visited[idx]) {
      continue;
    }

    let head = 0;
    let tail = 0;
    queue[tail++] = idx;
    visited[idx] = 1;

    let minX = inspectWidth;
    let minY = inspectHeight;
    let maxX = 0;
    let maxY = 0;
    let count = 0;

    while (head < tail) {
      const current = queue[head++];
      const x = current % inspectWidth;
      const y = Math.floor(current / inspectWidth);

      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
      count += 1;

      const left = current - 1;
      const right = current + 1;
      const up = current - inspectWidth;
      const down = current + inspectWidth;

      if (x > 0 && mask[left] && !visited[left]) {
        visited[left] = 1;
        queue[tail++] = left;
      }
      if (x + 1 < inspectWidth && mask[right] && !visited[right]) {
        visited[right] = 1;
        queue[tail++] = right;
      }
      if (y > 0 && mask[up] && !visited[up]) {
        visited[up] = 1;
        queue[tail++] = up;
      }
      if (y + 1 < inspectHeight && mask[down] && !visited[down]) {
        visited[down] = 1;
        queue[tail++] = down;
      }
    }

    if (count < minPixels) {
      continue;
    }

    components.push({
      x: minX,
      y: minY,
      width: maxX - minX + 1,
      height: maxY - minY + 1,
      red_pixel_count: count,
    });
  }

  const mergedBoxes = mergeNearbyBoxes(components)
    .filter((box) => box.red_pixel_count >= minPixels)
    .filter((box) => !isLikelyBottomDockArtifact(box, inspectWidth, inspectHeight))
    .filter((box) => !isLikelyTopCornerChromeArtifact(box, inspectWidth));

  const topChromeClusterCount = mergedBoxes.filter(isLikelyTopChromeClusterCandidate).length;

  const merged = mergedBoxes
    .filter(
      (box) =>
        !(
          topChromeClusterCount >= TOP_CHROME_CLUSTER_MIN_COUNT &&
          isLikelyTopChromeClusterCandidate(box)
        ),
    )
    .sort((a, b) => {
      if (b.red_pixel_count !== a.red_pixel_count) {
        return b.red_pixel_count - a.red_pixel_count;
      }
      if (a.y !== b.y) {
        return a.y - b.y;
      }
      return a.x - b.x;
    })
    .slice(0, MAX_REGIONS);

  const scaleX = originalWidth / inspectWidth;
  const scaleY = originalHeight / inspectHeight;

  return merged.map((box, index) => {
    const scaled = clampBox(
      {
        x: box.x * scaleX,
        y: box.y * scaleY,
        width: box.width * scaleX,
        height: box.height * scaleY,
      },
      originalWidth,
      originalHeight,
    );
    const area = Math.max(1, scaled.width * scaled.height);
    const redPixelRatio = Number((box.red_pixel_count / area).toFixed(4));
    const classification = classifyRegionType(
      {
        x: scaled.x,
        y: scaled.y,
        width: scaled.width,
        height: scaled.height,
        red_pixel_count: box.red_pixel_count,
      },
      redPixelRatio,
    );

    return {
      id: index + 1,
      ...scaled,
      red_pixel_ratio: redPixelRatio,
      red_pixel_count: box.red_pixel_count,
      coverage_ratio: Number((area / (originalWidth * originalHeight)).toFixed(4)),
      region_type: classification.region_type,
      region_type_confidence: classification.region_type_confidence,
    };
  });
}
