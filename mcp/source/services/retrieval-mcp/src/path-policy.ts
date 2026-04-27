import fs from "node:fs/promises";
import path from "node:path";

export const DEFAULT_EXCLUDE_GLOBS = [
  "!.git/**",
  "!.claude/worktrees/**",
  "!**/.claude/worktrees/**",
  "!node_modules/**",
  "!**/node_modules/**",
  "!dist/**",
  "!**/dist/**",
  "!build/**",
  "!**/build/**",
  "!coverage/**",
  "!**/coverage/**",
  "!.next/**",
  "!**/.next/**",
  "!.turbo/**",
  "!**/.turbo/**",
  "!vendor/**",
  "!**/vendor/**",
  "!*.lock",
  "!**/*.lock",
  "!package-lock.json",
  "!**/package-lock.json",
  "!pnpm-lock.yaml",
  "!**/pnpm-lock.yaml",
  "!yarn.lock",
  "!**/yarn.lock",
  "!claude/CREDENTIALS.md",
  "!**/CREDENTIALS.md",
  "!**/.env",
  "!**/.env.*",
  "!**/*secret*",
  "!**/*token*",
  "!**/*credential*",
  "!**/auth.json",
  "!**/*.pem",
  "!**/*.key",
  "!**/*.sqlite",
  "!**/*.sqlite-*",
];

const EXTRA_IGNORE_FILES = [
  ".cursorignore",
  ".windsurfignore",
  ".retrievalignore",
  ".retrieval-mcp-ignore",
];

export interface PathPolicySource {
  mode: "glob" | "rg-native";
  name: string;
  path?: string;
  patterns_loaded?: number;
  skipped_unignore_patterns?: number;
}

export interface PathPolicy {
  rgGlobs: string[];
  sources: PathPolicySource[];
  warnings: string[];
}

const BINARY_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".ico",
  ".pdf",
  ".zip",
  ".gz",
  ".tar",
  ".woff",
  ".woff2",
  ".ttf",
  ".otf",
  ".mp3",
  ".mp4",
  ".mov",
  ".sqlite",
]);

export function isLikelyBinary(filePath: string): boolean {
  return BINARY_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

export function isSensitivePath(relativePath: string): boolean {
  const normalized = relativePath.replace(/\\/g, "/").toLowerCase();
  return (
    normalized.includes("credentials.md") ||
    normalized.includes("/.env") ||
    normalized.includes("secret") ||
    normalized.includes("token") ||
    normalized.includes("auth.json") ||
    normalized.endsWith(".pem") ||
    normalized.endsWith(".key")
  );
}

export function displayPath(filePath: string): string {
  return filePath.replace(/\\/g, "/").replace(/^\.\//, "");
}

export function classifyFilteredPath(relativePath: string): string | null {
  if (isSensitivePath(relativePath)) {
    return "sensitive-path";
  }
  if (isLikelyBinary(relativePath)) {
    return "binary-extension";
  }
  return null;
}

function ignorePatternToRgGlobs(pattern: string): string[] {
  let normalized = pattern.trim();
  if (!normalized || normalized.startsWith("#")) {
    return [];
  }
  normalized = normalized.replace(/^\.\//, "").replace(/^\/+/, "");
  if (!normalized) {
    return [];
  }

  const directoryPattern = normalized.endsWith("/");
  normalized = normalized.replace(/\/+$/, "");
  const hasSlash = normalized.includes("/");
  const globs = new Set<string>();

  if (directoryPattern) {
    globs.add(`!${normalized}/**`);
    globs.add(`!**/${normalized}/**`);
  } else if (hasSlash) {
    globs.add(`!${normalized}`);
    globs.add(`!${normalized}/**`);
  } else {
    globs.add(`!${normalized}`);
    globs.add(`!**/${normalized}`);
    globs.add(`!${normalized}/**`);
    globs.add(`!**/${normalized}/**`);
  }

  return Array.from(globs);
}

async function loadExtraIgnoreGlobs(root: string): Promise<{
  globs: string[];
  sources: PathPolicySource[];
  warnings: string[];
}> {
  const globs = new Set<string>();
  const sources: PathPolicySource[] = [];
  const warnings: string[] = [];

  for (const fileName of EXTRA_IGNORE_FILES) {
    const absolutePath = path.join(root, fileName);
    let raw = "";
    try {
      raw = await fs.readFile(absolutePath, "utf8");
    } catch (error: any) {
      if (error?.code !== "ENOENT") {
        warnings.push(`could not read ${fileName}: ${error instanceof Error ? error.message : String(error)}`);
      }
      continue;
    }

    let patternsLoaded = 0;
    let skippedUnignore = 0;
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) {
        continue;
      }
      if (trimmed.startsWith("!")) {
        skippedUnignore += 1;
        continue;
      }
      for (const glob of ignorePatternToRgGlobs(trimmed)) {
        globs.add(glob);
      }
      patternsLoaded += 1;
    }

    sources.push({
      mode: "glob",
      name: fileName,
      path: displayPath(fileName),
      patterns_loaded: patternsLoaded,
      skipped_unignore_patterns: skippedUnignore || undefined,
    });
    if (skippedUnignore > 0) {
      warnings.push(`${fileName}: ${skippedUnignore} unignore pattern(s) ignored by retrieval path policy`);
    }
  }

  return { globs: Array.from(globs), sources, warnings };
}

export async function buildPathPolicy(
  root: string,
  includeGlobs?: string[],
  excludeGlobs?: string[],
  includeTests = true,
): Promise<PathPolicy> {
  const rgGlobs: string[] = [];
  for (const include of includeGlobs || []) {
    if (include.trim()) {
      rgGlobs.push(include.trim());
    }
  }

  rgGlobs.push(...DEFAULT_EXCLUDE_GLOBS);

  if (!includeTests) {
    rgGlobs.push(
      "!**/__tests__/**",
      "!**/tests/**",
      "!**/test/**",
      "!**/specs/**",
      "!**/*.test.*",
      "!**/*.spec.*",
    );
  }

  const extraIgnore = await loadExtraIgnoreGlobs(root);
  rgGlobs.push(...extraIgnore.globs);

  for (const exclude of excludeGlobs || []) {
    const trimmed = exclude.trim();
    if (trimmed) {
      rgGlobs.push(trimmed.startsWith("!") ? trimmed : `!${trimmed}`);
    }
  }

  return {
    rgGlobs: Array.from(new Set(rgGlobs)),
    sources: [
      {
        mode: "rg-native",
        name: ".gitignore",
      },
      {
        mode: "glob",
        name: "retrieval-default-excludes",
        patterns_loaded: DEFAULT_EXCLUDE_GLOBS.length,
      },
      ...extraIgnore.sources,
      ...(excludeGlobs?.length
        ? [
            {
              mode: "glob" as const,
              name: "request.exclude_globs",
              patterns_loaded: excludeGlobs.length,
            },
          ]
        : []),
    ],
    warnings: extraIgnore.warnings,
  };
}
