/**
 * VLM Analyzer for screenshot annotations
 * Uses local Qwen3-VL model via Ollama API
 * Replaces complex CV pipeline (Sharp + Tesseract + Heuristics)
 */

import fetch from "node-fetch";

export interface Annotation {
  id: number;
  comment_text: string;
  target_element: string;
  element_type?: string;
  suggested_fix?: string;
}

export interface UiObject {
  id: string;
  label: string;
  object_type: string;
  region_description: string;
  visible_text?: string;
  role_in_interface?: string;
}

export interface AnnotationObject {
  id: number;
  marker_label: string;
  comment_text: string;
  annotation_type?: string;
  region_description?: string;
}

export interface AnnotationLink {
  annotation_id: number;
  ui_object_id: string;
  relationship: string;
  rationale?: string;
}

export interface ScreenshotAnalysis {
  schema_version: string;
  analysis_scope: "full_frame";
  annotations: Annotation[];
  ui_objects: UiObject[];
  annotation_objects: AnnotationObject[];
  links: AnnotationLink[];
  ui_summary: string;
  raw_response?: string;
}

export interface VLMAnalyzerOptions {
  context?: string;
  model?: string;
  ollamaUrl?: string;
  timeout?: number;
  maxTokens?: number;
  temperature?: number;
}

const DEFAULT_OPTIONS: VLMAnalyzerOptions = {
  model: "qwen3-vl:latest",
  ollamaUrl: "http://localhost:11434/api/generate",
  timeout: 180000, // 3 minutes for large screenshots
  maxTokens: 2000, // Qwen3-VL needs more tokens (600 causes empty responses)
  temperature: 0.3, // Lower = faster, more deterministic
};

/**
 * Analyze screenshot using local VLM (Qwen3-VL via Ollama)
 * Detects red annotations, reads text, identifies target UI elements
 */
export async function analyzeScreenshotWithVLM(
  imageBase64: string,
  options: VLMAnalyzerOptions = {}
): Promise<ScreenshotAnalysis> {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const contextBlock = opts.context ? `Additional context: ${opts.context}\n\n` : "";

  const prompt = `${contextBlock}Analyze this full UI screenshot, not just the red markup.

Separate your reasoning into two layers:
1. Interface layer: visible UI objects such as panels, headers, buttons, inputs, charts, tables, modals, tabs, cards, nav areas, toolbars, media players, status blocks, and labels.
2. Annotation layer: red boxes, numbered comments, arrows, outlines, highlighted regions, underlines, or other reviewer markup.

For each annotation, identify:
1. The annotation number or marker label
2. The reviewer comment text
3. Which UI object it points to or comments on
4. What type of UI element that target is
5. A suggested fix

Return valid JSON only:
{
  "schema_version": "vision-mcp.v2",
  "analysis_scope": "full_frame",
  "ui_summary": "...",
  "ui_objects": [
    {
      "id": "ui-header-1",
      "label": "Main header",
      "object_type": "header",
      "region_description": "Top of the screen",
      "visible_text": "Dashboard",
      "role_in_interface": "primary navigation"
    }
  ],
  "annotation_objects": [
    {
      "id": 1,
      "marker_label": "(1)",
      "comment_text": "...",
      "annotation_type": "numbered_callout",
      "region_description": "Red box near the top right"
    }
  ],
  "links": [
    {
      "annotation_id": 1,
      "ui_object_id": "ui-header-1",
      "relationship": "points_to",
      "rationale": "The red arrow ends at the header title"
    }
  ],
  "annotations": [
    {
      "id": 1,
      "comment_text": "...",
      "target_element": "...",
      "element_type": "...",
      "suggested_fix": "..."
    }
  ]
}

Important:
- Use full-frame context to understand layout and target mapping.
- Do not reduce the answer to red lines only.
- Include all meaningful UI objects needed to understand the screenshot and each comment.`;

  try {
    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), opts.timeout);
    const response = await fetch(opts.ollamaUrl!, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        model: opts.model,
        prompt,
        images: [imageBase64],
        stream: false,
        options: {
          // Note: num_predict removed - Qwen3-VL works better without limit
          // 600 caused empty responses, 2000+ works but slower
          temperature: opts.temperature,
        }
      }),
    });
    clearTimeout(timeoutHandle);

    if (!response.ok) {
      throw new Error(`Ollama API error: ${response.status} ${response.statusText}`);
    }

    const result = await response.json() as { response: string };
    const rawResponse = result.response;

    // Try to parse JSON from response
    let analysis: ScreenshotAnalysis;
    try {
      // Extract JSON if wrapped in markdown code blocks
      const jsonMatch = rawResponse.match(/```(?:json)?\s*([\s\S]*?)```/);
      const jsonStr = jsonMatch ? jsonMatch[1] : rawResponse;

      analysis = normalizeAnalysis(JSON.parse(jsonStr), rawResponse);
    } catch (parseError) {
      // If JSON parsing fails, return structured fallback
      analysis = {
        schema_version: "vision-mcp.v2",
        analysis_scope: "full_frame",
        annotations: parseAnnotationsFromText(rawResponse),
        ui_objects: [],
        annotation_objects: [],
        links: [],
        ui_summary: "Screenshot analysis (parsing fallback)",
        raw_response: rawResponse,
      };
    }

    return analysis;
  } catch (error) {
    throw new Error(`VLM analysis failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function readNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string") {
    const parsed = Number.parseInt(value.trim(), 10);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return undefined;
}

function slugify(value: string): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return normalized || "item";
}

function normalizeAnnotations(value: unknown): Annotation[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item, index): Annotation | null => {
      if (!isRecord(item)) {
        return null;
      }

      const id = readNumber(item.id) || index + 1;
      const comment_text = readString(item.comment_text) || readString(item.comment) || "(no text detected)";
      const target_element =
        readString(item.target_element) || readString(item.target) || readString(item.ui_object_id) || "Unknown element";

      return {
        id,
        comment_text,
        target_element,
        element_type: readString(item.element_type) || readString(item.object_type) || readString(item.type),
        suggested_fix: readString(item.suggested_fix) || readString(item.fix),
      };
    })
    .filter((item): item is Annotation => item !== null);
}

function normalizeUiObjects(value: unknown): UiObject[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item, index): UiObject | null => {
      if (!isRecord(item)) {
        return null;
      }

      const label =
        readString(item.label) ||
        readString(item.name) ||
        readString(item.title) ||
        readString(item.target_element) ||
        `UI object ${index + 1}`;

      return {
        id: readString(item.id) || `ui-${slugify(label)}-${index + 1}`,
        label,
        object_type:
          readString(item.object_type) ||
          readString(item.element_type) ||
          readString(item.type) ||
          "interface_element",
        region_description:
          readString(item.region_description) ||
          readString(item.location) ||
          readString(item.bounds_description) ||
          "Visible on the screenshot",
        visible_text: readString(item.visible_text) || readString(item.text),
        role_in_interface: readString(item.role_in_interface) || readString(item.role),
      };
    })
    .filter((item): item is UiObject => item !== null);
}

function normalizeAnnotationObjects(value: unknown): AnnotationObject[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item, index): AnnotationObject | null => {
      if (!isRecord(item)) {
        return null;
      }

      const id = readNumber(item.id) || index + 1;
      const marker_label = readString(item.marker_label) || readString(item.label) || `(${id})`;

      return {
        id,
        marker_label,
        comment_text: readString(item.comment_text) || readString(item.comment) || "(no text detected)",
        annotation_type:
          readString(item.annotation_type) || readString(item.type) || "numbered_callout",
        region_description:
          readString(item.region_description) ||
          readString(item.location) ||
          readString(item.bounds_description),
      };
    })
    .filter((item): item is AnnotationObject => item !== null);
}

function findUiObjectId(uiObjects: UiObject[], hint: string | undefined): string | undefined {
  if (!hint) {
    return undefined;
  }

  const exact = uiObjects.find((item) => item.id === hint || item.label === hint);
  if (exact) {
    return exact.id;
  }

  const normalizedHint = slugify(hint);
  const fuzzy = uiObjects.find((item) => slugify(item.label) === normalizedHint || slugify(item.id) === normalizedHint);
  return fuzzy?.id;
}

function normalizeLinks(value: unknown, uiObjects: UiObject[]): AnnotationLink[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item): AnnotationLink | null => {
      if (!isRecord(item)) {
        return null;
      }

      const annotationId = readNumber(item.annotation_id) || readNumber(item.id);
      const explicitUiObjectId =
        readString(item.ui_object_id) ||
        findUiObjectId(uiObjects, readString(item.target_element) || readString(item.target) || readString(item.label));

      if (!annotationId || !explicitUiObjectId) {
        return null;
      }

      return {
        annotation_id: annotationId,
        ui_object_id: explicitUiObjectId,
        relationship: readString(item.relationship) || "points_to",
        rationale: readString(item.rationale) || readString(item.reason),
      };
    })
    .filter((item): item is AnnotationLink => item !== null);
}

function deriveUiObjectsFromAnnotations(annotations: Annotation[]): UiObject[] {
  const byTarget = new Map<string, UiObject>();

  for (const annotation of annotations) {
    const label = annotation.target_element?.trim();
    if (!label || label === "Unknown element" || byTarget.has(label)) {
      continue;
    }

    byTarget.set(label, {
      id: `ui-${slugify(label)}`,
      label,
      object_type: annotation.element_type || "interface_element",
      region_description: "Derived from annotation target mapping",
    });
  }

  return Array.from(byTarget.values());
}

function deriveAnnotationObjectsFromAnnotations(annotations: Annotation[]): AnnotationObject[] {
  return annotations.map((annotation) => ({
    id: annotation.id,
    marker_label: `(${annotation.id})`,
    comment_text: annotation.comment_text || "(no text detected)",
    annotation_type: "numbered_callout",
    region_description: "Derived from annotation summary",
  }));
}

function deriveLinksFromAnnotations(
  annotations: Annotation[],
  uiObjects: UiObject[],
): AnnotationLink[] {
  return annotations
    .map((annotation): AnnotationLink | null => {
      const uiObjectId = findUiObjectId(uiObjects, annotation.target_element);
      if (!uiObjectId) {
        return null;
      }

      return {
        annotation_id: annotation.id,
        ui_object_id: uiObjectId,
        relationship: "points_to",
        rationale: "Derived from annotation target_element",
      };
    })
    .filter((item): item is AnnotationLink => item !== null);
}

function deriveAnnotationsFromObjects(
  annotationObjects: AnnotationObject[],
  uiObjects: UiObject[],
  links: AnnotationLink[],
): Annotation[] {
  return annotationObjects.map((annotationObject) => {
    const linkedUiObject = links
      .filter((link) => link.annotation_id === annotationObject.id)
      .map((link) => uiObjects.find((uiObject) => uiObject.id === link.ui_object_id))
      .find((uiObject): uiObject is UiObject => Boolean(uiObject));

    return {
      id: annotationObject.id,
      comment_text: annotationObject.comment_text,
      target_element: linkedUiObject?.label || "Unknown element",
      element_type: linkedUiObject?.object_type,
    };
  });
}

function normalizeAnalysis(parsed: unknown, rawResponse: string): ScreenshotAnalysis {
  const record = isRecord(parsed) ? parsed : {};
  let annotations = normalizeAnnotations(record.annotations);
  let ui_objects = normalizeUiObjects(record.ui_objects);
  let annotation_objects = normalizeAnnotationObjects(record.annotation_objects);

  if (ui_objects.length === 0 && annotations.length > 0) {
    ui_objects = deriveUiObjectsFromAnnotations(annotations);
  }

  if (annotation_objects.length === 0 && annotations.length > 0) {
    annotation_objects = deriveAnnotationObjectsFromAnnotations(annotations);
  }

  let links = normalizeLinks(record.links, ui_objects);
  if (links.length === 0 && annotations.length > 0) {
    links = deriveLinksFromAnnotations(annotations, ui_objects);
  }

  if (annotations.length === 0 && annotation_objects.length > 0) {
    annotations = deriveAnnotationsFromObjects(annotation_objects, ui_objects, links);
  }

  return {
    schema_version: readString(record.schema_version) || "vision-mcp.v2",
    analysis_scope: "full_frame",
    annotations,
    ui_objects,
    annotation_objects,
    links,
    ui_summary: readString(record.ui_summary) || "Full-frame screenshot analysis",
    raw_response: rawResponse,
  };
}

/**
 * Fallback parser when JSON extraction fails
 * Extracts annotation patterns from text
 */
function parseAnnotationsFromText(text: string): Annotation[] {
  const annotations: Annotation[] = [];

  // Look for patterns like "Annotation ID: 1" or "(1)" or "1."
  const idPatterns = [
    /Annotation\s*ID[:\s]*(\d+)/gi,
    /\((\d+)\)/g,
    /^(\d+)[:\.\s]/gm,
  ];

  let matches: Array<{ id: number; index: number }> = [];

  for (const pattern of idPatterns) {
    let match;
    while ((match = pattern.exec(text)) !== null) {
      matches.push({ id: parseInt(match[1], 10), index: match.index });
    }
  }

  // Sort by position in text
  matches.sort((a, b) => a.index - b.index);

  // Extract text between IDs
  for (let i = 0; i < matches.length; i++) {
    const current = matches[i];
    const next = matches[i + 1];
    const endIndex = next ? next.index : text.length;
    const section = text.slice(current.index, endIndex);

    // Extract comment text (after "comment text" or similar)
    const commentMatch = section.match(/comment[:\s]*["']?([^"'\n]+)["']?/i) ||
                        section.match(/["']?([^"'\n]{10,100})["']?/);

    // Extract target element
    const targetMatch = section.match(/target[:\s]*["']?([^"'\n]+)["']?/i) ||
                       section.match(/element[:\s]*["']?([^"'\n]+)["']?/i);

    annotations.push({
      id: current.id,
      comment_text: commentMatch ? commentMatch[1].trim() : "See raw response",
      target_element: targetMatch ? targetMatch[1].trim() : "Unknown element",
    });
  }

  return annotations.length > 0 ? annotations : [{ id: 1, comment_text: text.slice(0, 200), target_element: "See full analysis" }];
}

/**
 * Check if Ollama is running and model is available
 */
export async function checkVLMStatus(
  ollamaUrl: string = "http://localhost:11434",
  model: string = "qwen3-vl:latest"
): Promise<{ ok: boolean; error?: string }> {
  try {
    const response = await fetch(`${ollamaUrl}/api/tags`, { method: "GET" });
    if (!response.ok) {
      return { ok: false, error: `Ollama not responding: ${response.status}` };
    }

    const data = await response.json() as { models: Array<{ name: string }> };
    const hasModel = data.models.some((m) => m.name === model || m.name.startsWith(model.split(":")[0]));

    if (!hasModel) {
      return { ok: false, error: `Model ${model} not found. Run: ollama pull ${model}` };
    }

    return { ok: true };
  } catch (error) {
    return { ok: false, error: `Cannot connect to Ollama: ${error instanceof Error ? error.message : String(error)}` };
  }
}
