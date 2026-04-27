import type { IgnoreRegionInput } from "./analysis-pipeline.js";

export type IgnorePresetName =
  | "top_browser_chrome"
  | "bottom_dock"
  | "right_scrollbar"
  | "left_sidebar"
  | "right_sidebar";

interface IgnorePresetDefinition {
  name: IgnorePresetName;
  reason: string;
  regions: IgnoreRegionInput[];
}

const PRESETS: Record<IgnorePresetName, IgnorePresetDefinition> = {
  top_browser_chrome: {
    name: "top_browser_chrome",
    reason: "Ignore top browser/window chrome band",
    regions: [
      {
        x: 0,
        y: 0,
        width: 1,
        height: 0.18,
        coordinate_space: "normalized",
        applies_to: "both",
        reason: "top browser chrome",
      },
    ],
  },
  bottom_dock: {
    name: "bottom_dock",
    reason: "Ignore bottom dock or taskbar zone",
    regions: [
      {
        x: 0,
        y: 0.88,
        width: 1,
        height: 0.12,
        coordinate_space: "normalized",
        applies_to: "both",
        reason: "bottom dock or taskbar",
      },
    ],
  },
  right_scrollbar: {
    name: "right_scrollbar",
    reason: "Ignore thin right scrollbar strip",
    regions: [
      {
        x: 0.982,
        y: 0.08,
        width: 0.018,
        height: 0.84,
        coordinate_space: "normalized",
        applies_to: "both",
        reason: "right scrollbar",
      },
    ],
  },
  left_sidebar: {
    name: "left_sidebar",
    reason: "Ignore left navigation rail",
    regions: [
      {
        x: 0,
        y: 0,
        width: 0.2,
        height: 1,
        coordinate_space: "normalized",
        applies_to: "both",
        reason: "left sidebar",
      },
    ],
  },
  right_sidebar: {
    name: "right_sidebar",
    reason: "Ignore right sidebar or inspector rail",
    regions: [
      {
        x: 0.8,
        y: 0,
        width: 0.2,
        height: 1,
        coordinate_space: "normalized",
        applies_to: "both",
        reason: "right sidebar",
      },
    ],
  },
};

export function listIgnorePresetNames(): IgnorePresetName[] {
  return Object.keys(PRESETS) as IgnorePresetName[];
}

export function expandIgnorePresets(input: unknown): {
  presetNames: IgnorePresetName[];
  regions: IgnoreRegionInput[];
} {
  if (!Array.isArray(input)) {
    return { presetNames: [], regions: [] };
  }

  const presetNames: IgnorePresetName[] = [];
  const regions: IgnoreRegionInput[] = [];

  for (const item of input) {
    if (typeof item !== "string") {
      continue;
    }

    const normalized = item.trim() as IgnorePresetName;
    if (!normalized || !(normalized in PRESETS)) {
      continue;
    }

    if (!presetNames.includes(normalized)) {
      presetNames.push(normalized);
      regions.push(...PRESETS[normalized].regions);
    }
  }

  return { presetNames, regions };
}
