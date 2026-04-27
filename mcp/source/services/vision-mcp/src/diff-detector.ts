export interface BoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DetectedChangedRegion extends BoundingBox {
  id: number;
  changed_pixel_count: number;
  changed_pixel_ratio: number;
  coverage_ratio: number;
  mean_abs_diff: number;
}

interface ComponentBox extends BoundingBox {
  changed_pixel_count: number;
  diff_sum: number;
}

const MAX_REGIONS = 8;
const NEARBY_GAP_PX = 20;
const TOP_EDGE_INSET_PX = 72;
const SIDE_EDGE_INSET_PX = 52;
const BOTTOM_EDGE_INSET_PX = 96;
const SMALL_EDGE_REGION_MAX_AREA_PX = 3200;
const SMALL_EDGE_REGION_MAX_DIMENSION_PX = 88;
const CHANGE_THRESHOLD_TOTAL = 78;
const CHANGE_THRESHOLD_CHANNEL = 26;

function isChangedPixel(
  r1: number,
  g1: number,
  b1: number,
  r2: number,
  g2: number,
  b2: number,
): { changed: boolean; diff: number } {
  const diffR = Math.abs(r1 - r2);
  const diffG = Math.abs(g1 - g2);
  const diffB = Math.abs(b1 - b2);
  const total = diffR + diffG + diffB;
  const maxChannel = Math.max(diffR, diffG, diffB);

  return {
    changed: total >= CHANGE_THRESHOLD_TOTAL && maxChannel >= CHANGE_THRESHOLD_CHANNEL,
    diff: total,
  };
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
    changed_pixel_count: a.changed_pixel_count + b.changed_pixel_count,
    diff_sum: a.diff_sum + b.diff_sum,
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

function isCompactEdgeRegion(box: ComponentBox): boolean {
  const area = box.width * box.height;
  const maxDimension = Math.max(box.width, box.height);

  return area <= SMALL_EDGE_REGION_MAX_AREA_PX && maxDimension <= SMALL_EDGE_REGION_MAX_DIMENSION_PX;
}

function isLikelyBottomDockArtifact(box: ComponentBox, imageHeight: number): boolean {
  return isCompactEdgeRegion(box) && box.y + box.height >= imageHeight - BOTTOM_EDGE_INSET_PX;
}

function isLikelyTopChromeArtifact(box: ComponentBox, imageWidth: number): boolean {
  if (!isCompactEdgeRegion(box)) {
    return false;
  }

  const nearTop = box.y <= TOP_EDGE_INSET_PX;
  const nearLeft = box.x <= SIDE_EDGE_INSET_PX;
  const nearRight = box.x + box.width >= imageWidth - SIDE_EDGE_INSET_PX;
  return nearTop && (nearLeft || nearRight);
}

function isLikelyScrollbarArtifact(box: ComponentBox, imageWidth: number, imageHeight: number): boolean {
  if (!isCompactEdgeRegion(box)) {
    return false;
  }

  const nearRight = box.x + box.width >= imageWidth - 28;
  const tallEnough = box.height >= 48;
  const thinEnough = box.width <= 18;
  const notPinnedTopOrBottom = box.y > TOP_EDGE_INSET_PX && box.y + box.height < imageHeight - BOTTOM_EDGE_INSET_PX;
  return nearRight && tallEnough && thinEnough && notPinnedTopOrBottom;
}

export async function detectChangedRegions(
  beforeRaw: Buffer,
  afterRaw: Buffer,
  width: number,
  height: number,
  channels: number,
): Promise<DetectedChangedRegion[]> {
  if (width <= 0 || height <= 0 || channels < 3) {
    return [];
  }

  const totalPixels = width * height;
  if (beforeRaw.length !== afterRaw.length || beforeRaw.length !== totalPixels * channels) {
    return [];
  }

  const mask = new Uint8Array(totalPixels);
  const diffStrength = new Uint16Array(totalPixels);
  let changedPixels = 0;

  for (let idx = 0; idx < totalPixels; idx += 1) {
    const offset = idx * channels;
    const result = isChangedPixel(
      beforeRaw[offset],
      beforeRaw[offset + 1],
      beforeRaw[offset + 2],
      afterRaw[offset],
      afterRaw[offset + 1],
      afterRaw[offset + 2],
    );

    if (result.changed) {
      mask[idx] = 1;
      diffStrength[idx] = result.diff;
      changedPixels += 1;
    }
  }

  if (changedPixels === 0) {
    return [];
  }

  const visited = new Uint8Array(totalPixels);
  const minPixels = Math.max(36, Math.round(totalPixels * 0.00008));
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

    let minX = width;
    let minY = height;
    let maxX = 0;
    let maxY = 0;
    let count = 0;
    let diffSum = 0;

    while (head < tail) {
      const current = queue[head++];
      const x = current % width;
      const y = Math.floor(current / width);

      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
      count += 1;
      diffSum += diffStrength[current];

      const left = current - 1;
      const right = current + 1;
      const up = current - width;
      const down = current + width;

      if (x > 0 && mask[left] && !visited[left]) {
        visited[left] = 1;
        queue[tail++] = left;
      }
      if (x + 1 < width && mask[right] && !visited[right]) {
        visited[right] = 1;
        queue[tail++] = right;
      }
      if (y > 0 && mask[up] && !visited[up]) {
        visited[up] = 1;
        queue[tail++] = up;
      }
      if (y + 1 < height && mask[down] && !visited[down]) {
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
      changed_pixel_count: count,
      diff_sum: diffSum,
    });
  }

  if (components.length === 0) {
    return [];
  }

  const merged = mergeNearbyBoxes(components);
  const filtered = merged
    .filter((box) => !isLikelyBottomDockArtifact(box, height))
    .filter((box) => !isLikelyTopChromeArtifact(box, width))
    .filter((box) => !isLikelyScrollbarArtifact(box, width, height))
    .sort((a, b) => {
      const areaDiff = b.width * b.height - a.width * a.height;
      if (areaDiff !== 0) {
        return areaDiff;
      }
      return b.changed_pixel_count - a.changed_pixel_count;
    })
    .slice(0, MAX_REGIONS);

  return filtered.map((box, index) => {
    const area = Math.max(1, box.width * box.height);
    return {
      id: index + 1,
      x: box.x,
      y: box.y,
      width: box.width,
      height: box.height,
      changed_pixel_count: box.changed_pixel_count,
      changed_pixel_ratio: Math.round((box.changed_pixel_count / area) * 100) / 100,
      coverage_ratio: Math.round((box.changed_pixel_count / totalPixels) * 10000) / 10000,
      mean_abs_diff: Math.round((box.diff_sum / Math.max(1, box.changed_pixel_count)) * 100) / 100,
    };
  });
}
