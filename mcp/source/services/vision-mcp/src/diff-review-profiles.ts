import type { IgnorePresetName } from "./ignore-presets.js";

export type DiffArtifactProfileName =
  | "anthropic_fast"
  | "anthropic_full"
  | "openai_low_detail"
  | "openai_high_detail";

export type DiffReviewProfileName =
  | "generic"
  | "browser_review"
  | "mobile_diff"
  | "dashboard_diff";

export interface DiffReviewProfile {
  name: DiffReviewProfileName;
  description: string;
  ignorePresets: IgnorePresetName[];
  recommendedArtifactProfile: DiffArtifactProfileName;
  guidance: string;
}

const PROFILES: Record<DiffReviewProfileName, DiffReviewProfile> = {
  generic: {
    name: "generic",
    description: "No extra assumptions beyond the default diff pipeline.",
    ignorePresets: [],
    recommendedArtifactProfile: "anthropic_fast",
    guidance: "Use the normal diff flow and expand profiles only if ambiguity remains.",
  },
  browser_review: {
    name: "browser_review",
    description: "Typical desktop browser screenshot review with browser chrome and scrollbar noise.",
    ignorePresets: ["top_browser_chrome", "right_scrollbar"],
    recommendedArtifactProfile: "anthropic_fast",
    guidance: "Treat browser chrome as noise and focus on product UI changes inside the page canvas.",
  },
  mobile_diff: {
    name: "mobile_diff",
    description: "Mobile-style screenshot compare with top chrome and bottom system bar noise.",
    ignorePresets: ["top_browser_chrome", "bottom_dock"],
    recommendedArtifactProfile: "anthropic_fast",
    guidance: "Prioritize the app viewport and ignore top/bottom system bands unless the user says they matter.",
  },
  dashboard_diff: {
    name: "dashboard_diff",
    description: "Dense dashboard/admin UI compare where a fuller artifact bundle is often worth it.",
    ignorePresets: ["top_browser_chrome", "right_scrollbar"],
    recommendedArtifactProfile: "anthropic_full",
    guidance: "Assume multiple meaningful changes may exist across dense widgets; expand to the fuller bundle earlier.",
  },
};

export function listDiffReviewProfileNames(): DiffReviewProfileName[] {
  return Object.keys(PROFILES) as DiffReviewProfileName[];
}

export function resolveDiffReviewProfile(input: unknown): DiffReviewProfile {
  if (typeof input === "string") {
    const normalized = input.trim() as DiffReviewProfileName;
    if (normalized && normalized in PROFILES) {
      return PROFILES[normalized];
    }
  }

  return PROFILES.generic;
}
