export type ScreenshotArtifactProfileName =
  | "anthropic_fast"
  | "anthropic_full"
  | "openai_low_detail"
  | "openai_high_detail";

export type ScreenshotTaskIntentName =
  | "generic"
  | "design_review"
  | "implementation_check"
  | "copy_review"
  | "bug_report";

export interface ScreenshotTaskIntentProfile {
  name: ScreenshotTaskIntentName;
  description: string;
  recommendedArtifactProfile: ScreenshotArtifactProfileName;
  fastMaxRegions: number;
  openaiHighDetailMaxRegions: number;
  guidance: string;
}

const PROFILES: Record<ScreenshotTaskIntentName, ScreenshotTaskIntentProfile> = {
  generic: {
    name: "generic",
    description: "Default screenshot-prep flow with no extra task assumptions.",
    recommendedArtifactProfile: "anthropic_fast",
    fastMaxRegions: 2,
    openaiHighDetailMaxRegions: 3,
    guidance: "Start with the budgeted fast package and expand only if the prepared artifacts leave ambiguity.",
  },
  design_review: {
    name: "design_review",
    description: "Annotated UI or visual-design feedback where layout, spacing, hierarchy, and component treatment matter most.",
    recommendedArtifactProfile: "anthropic_fast",
    fastMaxRegions: 2,
    openaiHighDetailMaxRegions: 3,
    guidance: "Focus on reviewer markup that changes layout, hierarchy, spacing, alignment, or component styling before copy-level details.",
  },
  implementation_check: {
    name: "implementation_check",
    description: "Verify whether a built UI matches the requested screenshot changes and map each annotation to the implemented target.",
    recommendedArtifactProfile: "anthropic_fast",
    fastMaxRegions: 3,
    openaiHighDetailMaxRegions: 4,
    guidance: "Treat each annotation as a requested implementation delta and verify the target UI element in its surrounding context before concluding pass or fail.",
  },
  copy_review: {
    name: "copy_review",
    description: "Text-heavy review where exact wording, labels, placeholders, and typo-level fidelity matter more than pure layout.",
    recommendedArtifactProfile: "anthropic_full",
    fastMaxRegions: 3,
    openaiHighDetailMaxRegions: 4,
    guidance: "Prioritize exact visible wording and UI labels; expand to fuller artifact bundles early if text or OCR hints are ambiguous.",
  },
  bug_report: {
    name: "bug_report",
    description: "Annotated bug or QA report where the visible symptom, state, and nearby interface context matter most.",
    recommendedArtifactProfile: "anthropic_fast",
    fastMaxRegions: 2,
    openaiHighDetailMaxRegions: 3,
    guidance: "Describe the visible bug symptom first, then connect annotations to the affected control, state, or content region in context.",
  },
};

export function listScreenshotTaskIntentNames(): ScreenshotTaskIntentName[] {
  return Object.keys(PROFILES) as ScreenshotTaskIntentName[];
}

export function resolveScreenshotTaskIntent(input: unknown): ScreenshotTaskIntentProfile {
  if (typeof input === "string") {
    const normalized = input.trim() as ScreenshotTaskIntentName;
    if (normalized && normalized in PROFILES) {
      return PROFILES[normalized];
    }
  }

  return PROFILES.generic;
}
