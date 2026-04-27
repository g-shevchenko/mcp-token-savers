import Ajv from "ajv/dist/2020.js";
import fs from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import { readArtifact, writeJsonArtifact } from "./artifact-store.js";
import {
  CONTRACT_SCHEMA_PIPELINE_VERSION,
  CONTRACT_SCHEMA_SCHEMA_VERSION,
  ContractSchemaConfig,
} from "./config.js";
import { estimateTokens, round, stableHash } from "./text-utils.js";

export interface ContractArgs {
  baseline?: unknown;
  baseline_artifact_file?: string;
  current?: unknown;
  env_paths?: string[];
  max_file_bytes?: number;
  max_files?: number;
  max_findings?: number;
  metadata?: unknown;
  openapi_paths?: string[];
  payload_sample?: unknown;
  repo_root?: string;
  schema?: unknown;
  schema_name?: string;
  schema_path?: string;
  zod_paths?: string[];
}

interface OpenApiOperation {
  method: string;
  operation_id?: string;
  operation_id_hash?: string;
  path_template: string;
  required_params_count: number;
  request_schema?: string;
  response_schema?: string;
  source_path: string;
}

interface OpenApiSchema {
  properties_count: number;
  required_fields: string[];
  schema_name: string;
  source_path: string;
  type?: string;
}

interface ZodSchema {
  fields: Array<{ field_name: string; optional: boolean; type_hint: string }>;
  fields_count: number;
  line: number;
  schema_kind: "const_object" | "embedded_object";
  schema_name: string;
  source_path: string;
}

interface EnvIndex {
  declared_env_vars: string[];
  missing_env_examples: string[];
  source_files: Array<Record<string, unknown>>;
  unused_declared_env_vars: string[];
  used_env_vars: string[];
}

interface ContractSnapshot {
  env: EnvIndex;
  openapi: {
    operations: OpenApiOperation[];
    schemas: OpenApiSchema[];
  };
  snapshot_hash?: string;
  zod: {
    schemas: ZodSchema[];
  };
}

const CONTRACT_EXTENSIONS = new Set([".json", ".yaml", ".yml", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".env", ".example", ".sample"]);
const OPENAPI_EXTENSIONS = new Set([".json", ".yaml", ".yml"]);
const CODE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);
const SKIP_DIRS = new Set([
  ".git",
  ".next",
  ".turbo",
  ".venv",
  ".wrangler",
  "coverage",
  "dist",
  "node_modules",
  "vendor",
]);

function repoRoot(args: ContractArgs): string {
  return path.resolve(args.repo_root || process.cwd());
}

function toPosix(value: string): string {
  return value.split(path.sep).join("/");
}

function positiveNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function maxFiles(config: ContractSchemaConfig, args: ContractArgs): number {
  return positiveNumber(args.max_files, config.maxFiles);
}

function maxFileBytes(config: ContractSchemaConfig, args: ContractArgs): number {
  return positiveNumber(args.max_file_bytes, config.maxFileBytes);
}

function maxFindings(config: ContractSchemaConfig, args: ContractArgs): number {
  return positiveNumber(args.max_findings, config.maxFindings);
}

function baseResult(toolKind: string, root: string) {
  return {
    schema_version: CONTRACT_SCHEMA_SCHEMA_VERSION,
    pipeline_version: CONTRACT_SCHEMA_PIPELINE_VERSION,
    repo: {
      repo_name: path.basename(root),
      repo_root_hash: stableHash(root),
    },
    tool_kind: toolKind,
    status: "ok",
    data_policy:
      "Advisory local contract/schema evidence only. Request logs store counts/hashes, not code bodies, env values, payload bodies, or secrets.",
  };
}

function attachStats<T extends object>(payload: T, rawChars: number): T & {
  compact_tokens_estimate: number;
  raw_tokens_estimate: number;
  saved_tokens_estimate: number;
  savings_pct: number;
} {
  const compactTokens = estimateTokens(JSON.stringify(payload));
  const rawTokens = estimateTokens(rawChars);
  const savedTokens = Math.max(0, rawTokens - compactTokens);
  return {
    ...payload,
    raw_tokens_estimate: rawTokens,
    compact_tokens_estimate: compactTokens,
    saved_tokens_estimate: savedTokens,
    savings_pct: rawTokens > 0 ? round((savedTokens / rawTokens) * 100) : 0,
  };
}

async function withArtifact<T extends object>(
  config: ContractSchemaConfig,
  prefix: string,
  payload: T,
): Promise<T & { artifact_file: string; artifact_url: string }> {
  const artifact = await writeJsonArtifact(config, prefix, payload);
  return {
    ...payload,
    ...artifact,
  };
}

async function collectFiles(
  config: ContractSchemaConfig,
  args: ContractArgs,
  include: (relPath: string) => boolean,
): Promise<Array<{ absPath: string; relPath: string; size: number }>> {
  const root = repoRoot(args);
  const rows: Array<{ absPath: string; relPath: string; size: number }> = [];
  const limit = maxFiles(config, args);
  const byteLimit = maxFileBytes(config, args);
  async function walk(dir: string): Promise<void> {
    if (rows.length >= limit) {
      return;
    }
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (rows.length >= limit) {
        return;
      }
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) {
          await walk(path.join(dir, entry.name));
        }
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      const absPath = path.join(dir, entry.name);
      const relPath = toPosix(path.relative(root, absPath));
      if (!include(relPath)) {
        continue;
      }
      let stat;
      try {
        stat = await fs.stat(absPath);
      } catch {
        continue;
      }
      if (stat.size > byteLimit) {
        continue;
      }
      rows.push({ absPath, relPath, size: stat.size });
    }
  }
  await walk(root);
  return rows;
}

async function readText(absPath: string): Promise<string> {
  try {
    return await fs.readFile(absPath, "utf8");
  } catch {
    return "";
  }
}

function explicitPathSet(root: string, values: string[] | undefined): Set<string> | null {
  if (!values || values.length === 0) {
    return null;
  }
  return new Set(values.map((value) => toPosix(path.relative(root, path.resolve(root, value)))));
}

function parseStructured(text: string, relPath: string): any | null {
  try {
    if (relPath.endsWith(".json")) {
      return JSON.parse(text);
    }
    return YAML.parse(text);
  } catch {
    return null;
  }
}

function schemaRefName(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const ref = (value as Record<string, unknown>).$ref;
  if (typeof ref === "string") {
    return ref.split("/").pop();
  }
  return undefined;
}

function extractRequestSchema(operation: any): string | undefined {
  const content = operation?.requestBody?.content;
  if (!content || typeof content !== "object") {
    return undefined;
  }
  for (const media of Object.values(content)) {
    const ref = schemaRefName((media as any)?.schema);
    if (ref) {
      return ref;
    }
  }
  return undefined;
}

function extractResponseSchema(operation: any): string | undefined {
  const responses = operation?.responses;
  if (!responses || typeof responses !== "object") {
    return undefined;
  }
  for (const response of Object.values(responses)) {
    const content = (response as any)?.content;
    if (!content || typeof content !== "object") {
      continue;
    }
    for (const media of Object.values(content)) {
      const ref = schemaRefName((media as any)?.schema);
      if (ref) {
        return ref;
      }
    }
  }
  return undefined;
}

function openApiFacts(doc: any, sourcePath: string): { operations: OpenApiOperation[]; schemas: OpenApiSchema[] } {
  const operations: OpenApiOperation[] = [];
  const schemas: OpenApiSchema[] = [];
  const paths = doc?.paths && typeof doc.paths === "object" ? doc.paths : {};
  const methods = new Set(["get", "post", "put", "patch", "delete", "options", "head"]);
  for (const [pathTemplate, pathItem] of Object.entries(paths)) {
    if (!pathItem || typeof pathItem !== "object") {
      continue;
    }
    for (const [methodRaw, operation] of Object.entries(pathItem as Record<string, unknown>)) {
      const method = methodRaw.toLowerCase();
      if (!methods.has(method) || !operation || typeof operation !== "object") {
        continue;
      }
      const params = Array.isArray((operation as any).parameters) ? (operation as any).parameters : [];
      const requiredParams = params.filter((param: any) => param?.required === true).length;
      const operationId = typeof (operation as any).operationId === "string" ? (operation as any).operationId : undefined;
      operations.push({
        method: method.toUpperCase(),
        operation_id: operationId,
        operation_id_hash: operationId ? stableHash(operationId) : undefined,
        path_template: String(pathTemplate),
        required_params_count: requiredParams,
        request_schema: extractRequestSchema(operation),
        response_schema: extractResponseSchema(operation),
        source_path: sourcePath,
      });
    }
  }
  const componentSchemas = doc?.components?.schemas && typeof doc.components.schemas === "object" ? doc.components.schemas : {};
  for (const [schemaName, schema] of Object.entries(componentSchemas)) {
    const properties = (schema as any)?.properties && typeof (schema as any).properties === "object" ? (schema as any).properties : {};
    const required = Array.isArray((schema as any)?.required) ? (schema as any).required.filter((item: unknown) => typeof item === "string") : [];
    schemas.push({
      properties_count: Object.keys(properties).length,
      required_fields: required.sort(),
      schema_name: schemaName,
      source_path: sourcePath,
      type: typeof (schema as any)?.type === "string" ? (schema as any).type : undefined,
    });
  }
  return { operations, schemas };
}

export async function indexOpenApi(config: ContractSchemaConfig, args: ContractArgs = {}) {
  const root = repoRoot(args);
  const explicit = explicitPathSet(root, args.openapi_paths);
  const files = await collectFiles(config, args, (relPath) => {
    if (explicit) {
      return explicit.has(relPath);
    }
    const ext = path.extname(relPath).toLowerCase();
    const lower = relPath.toLowerCase();
    return OPENAPI_EXTENSIONS.has(ext) && /openapi|swagger|api[-_]?schema|contract/.test(lower);
  });
  const operations: OpenApiOperation[] = [];
  const schemas: OpenApiSchema[] = [];
  let rawChars = 0;
  const parseErrors: Array<Record<string, unknown>> = [];
  for (const file of files) {
    const text = await readText(file.absPath);
    rawChars += text.length;
    const parsed = parseStructured(text, file.relPath);
    if (!parsed || (!parsed.openapi && !parsed.swagger)) {
      continue;
    }
    try {
      const facts = openApiFacts(parsed, file.relPath);
      operations.push(...facts.operations);
      schemas.push(...facts.schemas);
    } catch {
      parseErrors.push({ source_path: file.relPath, file_hash: stableHash(file.relPath), reason: "OpenAPI structure could not be indexed." });
    }
  }
  const result = attachStats(
    {
      ...baseResult("openapi_index", root),
      openapi_files_count: files.length,
      operations_count: operations.length,
      schemas_count: schemas.length,
      parse_errors_count: parseErrors.length,
      operations: operations.slice(0, maxFindings(config, args)),
      schemas: schemas.slice(0, maxFindings(config, args)),
      parse_errors: parseErrors.slice(0, maxFindings(config, args)),
      truncated: operations.length + schemas.length > maxFindings(config, args) * 2,
    },
    rawChars,
  );
  return withArtifact(config, "openapi-index", result);
}

function findMatchingBrace(text: string, openIndex: number): number {
  let depth = 0;
  for (let index = openIndex; index < text.length; index += 1) {
    const char = text[index];
    if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }
  return -1;
}

function lineFor(text: string, index: number): number {
  return text.slice(0, index).split(/\r?\n/).length;
}

function zodTypeHint(expr: string): string {
  const match = /z\.(string|number|boolean|array|object|enum|literal|date|record|unknown|any|nativeEnum)/.exec(expr);
  return match?.[1] || "unknown";
}

function parseZodObjectSchema(
  text: string,
  relPath: string,
  name: string,
  matchIndex: number,
  schemaKind: ZodSchema["schema_kind"],
): ZodSchema | null {
  const objectStart = text.indexOf("{", matchIndex);
  if (objectStart < 0) {
    return null;
  }
  const objectEnd = findMatchingBrace(text, objectStart);
  if (objectEnd < 0) {
    return null;
  }
  const body = text.slice(objectStart + 1, objectEnd);
  const fields: Array<{ field_name: string; optional: boolean; type_hint: string }> = [];
  const fieldRe = /([A-Za-z_][A-Za-z0-9_]*)\s*:\s*([^,\n]+(?:\([^)]*\))?[^,\n]*)/g;
  for (const fieldMatch of body.matchAll(fieldRe)) {
    const fieldName = fieldMatch[1];
    const expr = fieldMatch[2] || "";
    if (!fieldName || fieldName === "z") {
      continue;
    }
    fields.push({
      field_name: fieldName,
      optional: /\.optional\s*\(/.test(expr) || /\.nullish\s*\(/.test(expr) || /\.nullable\s*\(/.test(expr),
      type_hint: zodTypeHint(expr),
    });
  }
  return {
    fields,
    fields_count: fields.length,
    line: lineFor(text, matchIndex),
    schema_kind: schemaKind,
    schema_name: name,
    source_path: relPath,
  };
}

function pushUniqueSchema(schemas: ZodSchema[], schema: ZodSchema | null): void {
  if (!schema) {
    return;
  }
  const key = `${schema.source_path}:${schema.line}:${schema.schema_kind}:${schema.schema_name}`;
  if (!schemas.some((item) => `${item.source_path}:${item.line}:${item.schema_kind}:${item.schema_name}` === key)) {
    schemas.push(schema);
  }
}

function extractZodSchemas(text: string, relPath: string): ZodSchema[] {
  const schemas: ZodSchema[] = [];
  const schemaRe = /(?:export\s+)?const\s+([A-Za-z0-9_]+)\s*=\s*z\.object\s*\(/g;
  for (const match of text.matchAll(schemaRe)) {
    const name = match[1] || "AnonymousSchema";
    pushUniqueSchema(schemas, parseZodObjectSchema(text, relPath, name, match.index || 0, "const_object"));
  }
  const embeddedSchemaRe = /([A-Za-z_][A-Za-z0-9_]*)\s*:\s*z\.object\s*\(/g;
  for (const match of text.matchAll(embeddedSchemaRe)) {
    const name = match[1] || "embeddedObject";
    pushUniqueSchema(schemas, parseZodObjectSchema(text, relPath, name, match.index || 0, "embedded_object"));
  }
  return schemas;
}

export async function indexZod(config: ContractSchemaConfig, args: ContractArgs = {}) {
  const root = repoRoot(args);
  const explicit = explicitPathSet(root, args.zod_paths);
  const files = await collectFiles(config, args, (relPath) => {
    if (explicit) {
      return explicit.has(relPath);
    }
    return CODE_EXTENSIONS.has(path.extname(relPath).toLowerCase());
  });
  const schemas: ZodSchema[] = [];
  let rawChars = 0;
  let zodFiles = 0;
  for (const file of files) {
    const text = await readText(file.absPath);
    if (!/\bz\b|from\s+["']zod["']|require\(["']zod["']\)/.test(text)) {
      continue;
    }
    rawChars += text.length;
    const found = extractZodSchemas(text, file.relPath);
    if (found.length > 0) {
      zodFiles += 1;
      schemas.push(...found);
    }
  }
  const result = attachStats(
    {
      ...baseResult("zod_index", root),
      zod_files_count: zodFiles,
      zod_schemas_count: schemas.length,
      zod_embedded_schemas_count: schemas.filter((schema) => schema.schema_kind === "embedded_object").length,
      zod_fields_count: schemas.reduce((sum, schema) => sum + schema.fields_count, 0),
      schemas: schemas.slice(0, maxFindings(config, args)),
      truncated: schemas.length > maxFindings(config, args),
    },
    rawChars,
  );
  return withArtifact(config, "zod-index", result);
}

function parseEnvDeclarations(text: string): string[] {
  const names = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    let clean = line.trim();
    if (!clean || clean.startsWith("#")) {
      continue;
    }
    if (clean.startsWith("export ")) {
      clean = clean.slice("export ".length).trim();
    }
    const match = /^([A-Z][A-Z0-9_]{1,})\s*=/.exec(clean);
    if (match?.[1]) {
      names.add(match[1]);
    }
  }
  return Array.from(names).sort();
}

function parseEnvUsages(text: string): string[] {
  const names = new Set<string>();
  for (const match of text.matchAll(/process\.env\.([A-Z][A-Z0-9_]{1,})/g)) {
    if (match[1]) {
      names.add(match[1]);
    }
  }
  for (const match of text.matchAll(/process\.env\[['"]([A-Z][A-Z0-9_]{1,})['"]]/g)) {
    if (match[1]) {
      names.add(match[1]);
    }
  }
  for (const match of text.matchAll(/\b(?:const|let|var)\s*\{([^}]+)}\s*=\s*process\.env\b/g)) {
    const body = match[1] || "";
    for (const item of body.split(",")) {
      const name = item.trim().split(":")[0]?.trim();
      if (name && /^[A-Z][A-Z0-9_]{1,}$/.test(name)) {
        names.add(name);
      }
    }
  }
  return Array.from(names).sort();
}

function isEnvExample(relPath: string): boolean {
  const base = path.basename(relPath).toLowerCase();
  return /^\.?env(\.|-)?(example|sample|template|local\.example)$/.test(base) || base.endsWith(".env.example");
}

export async function indexEnvContracts(config: ContractSchemaConfig, args: ContractArgs = {}) {
  const root = repoRoot(args);
  const explicit = explicitPathSet(root, args.env_paths);
  const files = await collectFiles(config, args, (relPath) => {
    if (explicit) {
      return explicit.has(relPath);
    }
    const ext = path.extname(relPath).toLowerCase();
    return isEnvExample(relPath) || CODE_EXTENSIONS.has(ext);
  });
  const declared = new Set<string>();
  const used = new Set<string>();
  const sourceFiles: Array<Record<string, unknown>> = [];
  let rawChars = 0;
  for (const file of files) {
    const text = await readText(file.absPath);
    rawChars += text.length;
    if (isEnvExample(file.relPath)) {
      const names = parseEnvDeclarations(text);
      for (const name of names) {
        declared.add(name);
      }
      if (names.length > 0) {
        sourceFiles.push({ source_path: file.relPath, declared_count: names.length, file_hash: stableHash(file.relPath) });
      }
      continue;
    }
    const usages = parseEnvUsages(text);
    for (const name of usages) {
      used.add(name);
    }
    if (usages.length > 0) {
      sourceFiles.push({ source_path: file.relPath, used_count: usages.length, file_hash: stableHash(file.relPath) });
    }
  }
  const declaredRows = Array.from(declared).sort();
  const usedRows = Array.from(used).sort();
  const missing = usedRows.filter((name) => !declared.has(name));
  const unused = declaredRows.filter((name) => !used.has(name));
  const result = attachStats(
    {
      ...baseResult("env_contract_index", root),
      env_declared_count: declaredRows.length,
      env_used_count: usedRows.length,
      missing_env_examples_count: missing.length,
      unused_env_declared_count: unused.length,
      declared_env_vars: declaredRows.slice(0, maxFindings(config, args)),
      used_env_vars: usedRows.slice(0, maxFindings(config, args)),
      missing_env_examples: missing.slice(0, maxFindings(config, args)),
      unused_declared_env_vars: unused.slice(0, maxFindings(config, args)),
      source_files: sourceFiles.slice(0, maxFindings(config, args)),
      truncated: declaredRows.length + usedRows.length > maxFindings(config, args) * 2,
    },
    rawChars,
  );
  return withArtifact(config, "env-contract-index", result);
}

export async function createContractSnapshot(config: ContractSchemaConfig, args: ContractArgs = {}) {
  const root = repoRoot(args);
  const [openapi, zod, env] = await Promise.all([indexOpenApi(config, args), indexZod(config, args), indexEnvContracts(config, args)]);
  const snapshot: ContractSnapshot = {
    env: {
      declared_env_vars: (openArray(env.declared_env_vars) as string[]).sort(),
      missing_env_examples: (openArray(env.missing_env_examples) as string[]).sort(),
      source_files: openArray(env.source_files) as Array<Record<string, unknown>>,
      unused_declared_env_vars: (openArray(env.unused_declared_env_vars) as string[]).sort(),
      used_env_vars: (openArray(env.used_env_vars) as string[]).sort(),
    },
    openapi: {
      operations: openArray(openapi.operations) as OpenApiOperation[],
      schemas: openArray(openapi.schemas) as OpenApiSchema[],
    },
    zod: {
      schemas: openArray(zod.schemas) as ZodSchema[],
    },
  };
  snapshot.snapshot_hash = stableHash(JSON.stringify(snapshot));
  const rawTokens = Number(openapi.raw_tokens_estimate || 0) + Number(zod.raw_tokens_estimate || 0) + Number(env.raw_tokens_estimate || 0);
  const result = attachStats(
    {
      ...baseResult("contract_snapshot", root),
      snapshot_hash: snapshot.snapshot_hash,
      contract_snapshots: 1,
      openapi_files_count: Number(openapi.openapi_files_count || 0),
      operations_count: snapshot.openapi.operations.length,
      schemas_count: snapshot.openapi.schemas.length,
      zod_embedded_schemas_count: snapshot.zod.schemas.filter((schema) => schema.schema_kind === "embedded_object").length,
      zod_schemas_count: snapshot.zod.schemas.length,
      env_declared_count: snapshot.env.declared_env_vars.length,
      env_used_count: snapshot.env.used_env_vars.length,
      missing_env_examples_count: snapshot.env.missing_env_examples.length,
      snapshot,
      source_artifacts: {
        openapi: openapi.artifact_file,
        zod: zod.artifact_file,
        env: env.artifact_file,
      },
    },
    rawTokens * 4,
  );
  return withArtifact(config, "contract-snapshot", result);
}

function openArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asSnapshot(value: unknown): ContractSnapshot | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const candidate = record.snapshot && typeof record.snapshot === "object" ? (record.snapshot as Record<string, unknown>) : record;
  if (!candidate.openapi || !candidate.zod || !candidate.env) {
    return null;
  }
  return candidate as unknown as ContractSnapshot;
}

function operationKey(operation: OpenApiOperation): string {
  return `${operation.method} ${operation.path_template}`;
}

function schemaKey(schema: OpenApiSchema | ZodSchema): string {
  return `${schema.source_path}:${"schema_name" in schema ? schema.schema_name : "unknown"}`;
}

export async function diffContracts(config: ContractSchemaConfig, args: ContractArgs = {}) {
  const root = repoRoot(args);
  let baseline = asSnapshot(args.baseline);
  if (!baseline && args.baseline_artifact_file) {
    const artifact = await readArtifact(config, args.baseline_artifact_file, config.maxArtifactChars);
    baseline = asSnapshot(JSON.parse(artifact.text));
  }
  const current =
    asSnapshot(args.current) ||
    asSnapshot((await createContractSnapshot(config, args)).snapshot);
  if (!baseline || !current) {
    throw new Error("baseline and current contract snapshots are required");
  }
  const baselineOps = new Map(baseline.openapi.operations.map((item) => [operationKey(item), item]));
  const currentOps = new Map(current.openapi.operations.map((item) => [operationKey(item), item]));
  const removedOperations = Array.from(baselineOps.entries())
    .filter(([key]) => !currentOps.has(key))
    .map(([, operation]) => operation);
  const baselineOpenSchemas = new Map(baseline.openapi.schemas.map((item) => [schemaKey(item), item]));
  const currentOpenSchemas = new Map(current.openapi.schemas.map((item) => [schemaKey(item), item]));
  const removedSchemaFields: Array<Record<string, unknown>> = [];
  for (const [key, baseSchema] of baselineOpenSchemas.entries()) {
    const next = currentOpenSchemas.get(key);
    if (!next) {
      removedSchemaFields.push({
        schema_key: key,
        schema_hash: stableHash(key),
        removed_schema: true,
        removed_required_fields_count: baseSchema.required_fields.length,
      });
      continue;
    }
    for (const field of baseSchema.required_fields) {
      if (!next.required_fields.includes(field)) {
        removedSchemaFields.push({
          schema_key: key,
          schema_hash: stableHash(key),
          field_name: field,
          field_hash: stableHash(field),
          removed_required_field: true,
        });
      }
    }
  }
  const baselineEnv = new Set(baseline.env.declared_env_vars);
  const currentEnv = new Set(current.env.declared_env_vars);
  const removedEnvVars = Array.from(baselineEnv).filter((name) => !currentEnv.has(name)).sort();
  const result = attachStats(
    {
      ...baseResult("contract_diff", root),
      baseline_hash: stableHash(JSON.stringify(baseline)),
      current_hash: stableHash(JSON.stringify(current)),
      diff_removed_operations: removedOperations.length,
      diff_removed_schema_fields: removedSchemaFields.length,
      diff_removed_env_vars: removedEnvVars.length,
      breaking_changes_count: removedOperations.length + removedSchemaFields.length + removedEnvVars.length,
      removed_operations: removedOperations.slice(0, maxFindings(config, args)),
      removed_schema_fields: removedSchemaFields.slice(0, maxFindings(config, args)),
      removed_env_vars: removedEnvVars.slice(0, maxFindings(config, args)),
    },
    JSON.stringify({ baseline, current }).length,
  );
  return withArtifact(config, "contract-diff", result);
}

export async function validatePayloadSample(config: ContractSchemaConfig, args: ContractArgs = {}) {
  const root = repoRoot(args);
  if (!args.schema || typeof args.schema !== "object") {
    throw new Error("schema object is required");
  }
  const AjvCtor = (Ajv as any).default || Ajv;
  const ajv = new AjvCtor({ allErrors: true, strict: false });
  const validate = ajv.compile(args.schema as Record<string, unknown>);
  const valid = validate(args.payload_sample);
  const errors = (validate.errors || []).map((error: any) => ({
    instance_path: error.instancePath,
    keyword: error.keyword,
    message: error.message,
    schema_path: error.schemaPath,
  }));
  const result = attachStats(
    {
      ...baseResult("payload_validation", root),
      payload_valid: valid === true,
      payload_validation_failures: valid === true ? 0 : 1,
      validation_errors_count: errors.length,
      schema_hash: stableHash(JSON.stringify(args.schema)),
      payload_hash: stableHash(JSON.stringify(args.payload_sample)),
      errors: errors.slice(0, maxFindings(config, args)),
      truncated: errors.length > maxFindings(config, args),
    },
    JSON.stringify({ schema: args.schema, payload_sample: args.payload_sample }).length,
  );
  return withArtifact(config, "payload-validation", result);
}

export async function summarizeBreakingChanges(config: ContractSchemaConfig, args: ContractArgs = {}) {
  const root = repoRoot(args);
  const diff = await diffContracts(config, args);
  const changes: Array<Record<string, unknown>> = [];
  for (const operation of (openArray(diff.removed_operations) as OpenApiOperation[]).slice(0, 10)) {
    changes.push({
      change_type: "removed_operation",
      severity: "breaking",
      evidence: {
        method: operation.method,
        path_template: operation.path_template,
        source_path: operation.source_path,
      },
      required_proof: ["confirm endpoint removal is intentional", "update clients/tests/docs", "publish migration note if external"],
    });
  }
  for (const field of (openArray(diff.removed_schema_fields) as Array<Record<string, unknown>>).slice(0, 10)) {
    changes.push({
      change_type: "removed_required_schema_field",
      severity: "breaking",
      evidence: field,
      required_proof: ["confirm payload compatibility", "update validators/fixtures", "run focused contract tests"],
    });
  }
  for (const envName of (openArray(diff.removed_env_vars) as string[]).slice(0, 10)) {
    changes.push({
      change_type: "removed_env_contract",
      severity: "review",
      evidence: {
        env_name: envName,
        env_hash: stableHash(envName),
      },
      required_proof: ["confirm runtime no longer reads this env var", "update deployment templates and docs"],
    });
  }
  const result = attachStats(
    {
      ...baseResult("breaking_change_summary", root),
      breaking_changes_count: changes.length,
      changes: changes.slice(0, maxFindings(config, args)),
      source_artifact: diff.artifact_file,
      policy: {
        advisory_only: true,
        agents_must_read_exact_contract_files_before_edits: true,
      },
    },
    Number(diff.raw_tokens_estimate || 0) * 4,
  );
  return withArtifact(config, "breaking-change-summary", result);
}
