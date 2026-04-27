#!/usr/bin/env node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

function argValue(name, fallback = "") {
  const prefix = `${name}=`;
  const match = process.argv.find((arg) => arg.startsWith(prefix));
  return match ? match.slice(prefix.length) : fallback;
}

const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "contract-schema-mcp-benchmark-"));
process.env.CONTRACT_SCHEMA_CACHE_DIR = path.join(tempDir, "cache");
const fixture = path.join(tempDir, "fixture");
await fs.mkdir(path.join(fixture, "src"), { recursive: true });
await fs.mkdir(path.join(fixture, "contracts"), { recursive: true });

const openApiPath = path.join(fixture, "contracts", "openapi.json");
await fs.writeFile(
  openApiPath,
  JSON.stringify(
    {
      openapi: "3.1.0",
      paths: {
        "/users": {
          get: { operationId: "listUsers", responses: { "200": { description: "ok" } } },
          post: {
            operationId: "createUser",
            requestBody: { content: { "application/json": { schema: { $ref: "#/components/schemas/UserInput" } } } },
            responses: { "201": { description: "created", content: { "application/json": { schema: { $ref: "#/components/schemas/User" } } } } },
          },
        },
      },
      components: {
        schemas: {
          UserInput: { type: "object", required: ["email"], properties: { email: { type: "string" }, age: { type: "number" } } },
          User: { type: "object", required: ["id", "email"], properties: { id: { type: "string" }, email: { type: "string" } } },
        },
      },
    },
    null,
    2,
  ),
  "utf8",
);
await fs.writeFile(
  path.join(fixture, "src", "contracts.ts"),
  [
    'import { z } from "zod";',
    "",
    "export const UserInputSchema = z.object({",
    "  email: z.string().email(),",
    "  age: z.number().optional(),",
    "});",
    "",
  ].join("\n"),
  "utf8",
);
await fs.writeFile(
  path.join(fixture, "src", "mcp-tool.js"),
  [
    'import { z } from "zod";',
    "",
    "server.tool(",
    '  "promote_admin",',
    '  "Promote a user to admin",',
    "  {",
    '    group: z.string().describe("Group username or ID"),',
    '    user: z.string().describe("User username"),',
    "    rights: z.object({",
    "      deleteMessages: z.boolean().optional(),",
    "      banUsers: z.boolean().optional(),",
    '      rank: z.string().optional().describe("Custom admin title"),',
    '    }).optional().describe("Admin rights"),',
    "  },",
    "  async () => ({ content: [] }),",
    ");",
    "",
  ].join("\n"),
  "utf8",
);
await fs.writeFile(path.join(fixture, ".env.example"), "API_BASE_URL=\nTWENTY_API_KEY=\nexport OPTIONAL_ENV=\n", "utf8");
await fs.writeFile(
  path.join(fixture, "src", "env.ts"),
  "export const apiBase = process.env.API_BASE_URL;\nexport const missing = process.env.MISSING_ENV;\nconst { OPTIONAL_ENV: optionalEnv } = process.env;\nexport const optional = optionalEnv;\n",
  "utf8",
);

const { getContractSchemaConfig } = await import("../dist/config.js");
const {
  createContractSnapshot,
  diffContracts,
  indexEnvContracts,
  indexOpenApi,
  indexZod,
  summarizeBreakingChanges,
  validatePayloadSample,
} = await import("../dist/contracts.js");
const { buildMeasurementReport } = await import("../dist/measurement.js");

const config = getContractSchemaConfig();
const args = { repo_root: fixture, max_files: 80, max_findings: 20, metadata: { source: "benchmark-local" } };
const baseline = await createContractSnapshot(config, args);

await fs.writeFile(
  openApiPath,
  JSON.stringify(
    {
      openapi: "3.1.0",
      paths: {
        "/users": {
          get: { operationId: "listUsers", responses: { "200": { description: "ok" } } },
        },
      },
      components: {
        schemas: {
          UserInput: { type: "object", required: [], properties: { email: { type: "string" }, age: { type: "number" } } },
          User: { type: "object", required: ["id", "email"], properties: { id: { type: "string" }, email: { type: "string" } } },
        },
      },
    },
    null,
    2,
  ),
  "utf8",
);
await fs.writeFile(path.join(fixture, ".env.example"), "API_BASE_URL=\n", "utf8");

const failures = [];
function assert(name, condition, details = {}) {
  if (!condition) failures.push({ name, details });
}

const openapi = await indexOpenApi(config, args);
const zod = await indexZod(config, args);
const env = await indexEnvContracts(config, args);
const current = await createContractSnapshot(config, args);
const diff = await diffContracts(config, { ...args, baseline: baseline.snapshot, current: current.snapshot });
const validation = await validatePayloadSample(config, {
  ...args,
  schema: { type: "object", required: ["email"], properties: { email: { type: "string" } } },
  payload_sample: { age: 31 },
});
const breaking = await summarizeBreakingChanges(config, { ...args, baseline: baseline.snapshot, current: current.snapshot });
const measurement = await buildMeasurementReport(config, { date: new Date().toISOString().slice(0, 10) });
const combined = JSON.stringify({ openapi, zod, env, current, diff, validation, breaking, measurement });

assert("openapi-operation-index", openapi.operations_count >= 1, openapi);
assert("openapi-schema-index", openapi.schemas_count >= 2, openapi);
assert("zod-schema-index", zod.zod_schemas_count >= 1 && zod.zod_fields_count >= 2, zod);
assert("zod-embedded-tool-schema-index", zod.zod_embedded_schemas_count >= 1 && zod.schemas.some((schema) => schema.schema_name === "rights"), zod);
assert("env-missing-example", env.missing_env_examples_count >= 1, env);
assert("payload-invalid", validation.payload_valid === false && validation.validation_errors_count >= 1, validation);
assert("diff-removed-operation", diff.diff_removed_operations >= 1, diff);
assert("diff-removed-required-field", diff.diff_removed_schema_fields >= 1, diff);
assert("breaking-summary", breaking.breaking_changes_count >= 2, breaking);
assert("measurement-safe", measurement.pantheon_export.safe_for_pantheon === true, measurement.pantheon_export);
assert("no-raw-code-or-env-value-leak", !combined.includes("process.env.MISSING_ENV") && !combined.includes("z.string().email") && !combined.includes(tempDir), {});

const result = {
  benchmark: "contract-schema-local-golden",
  cases: 11,
  failures,
  rows: [
    { name: "operations", value: openapi.operations_count },
    { name: "schemas", value: openapi.schemas_count },
    { name: "zod-schemas", value: zod.zod_schemas_count },
    { name: "zod-embedded-schemas", value: zod.zod_embedded_schemas_count },
    { name: "missing-env-examples", value: env.missing_env_examples_count },
    { name: "validation-errors", value: validation.validation_errors_count },
    { name: "removed-operations", value: diff.diff_removed_operations },
    { name: "removed-schema-fields", value: diff.diff_removed_schema_fields },
    { name: "breaking-changes", value: breaking.breaking_changes_count },
    { name: "measurement-calls", value: measurement.usage.calls },
  ],
};

const outPath = argValue("--out");
if (outPath) {
  await fs.mkdir(path.dirname(path.resolve(outPath)), { recursive: true });
  await fs.writeFile(path.resolve(outPath), `${JSON.stringify(result, null, 2)}\n`, "utf8");
}
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
process.exit(failures.length ? 1 : 0);
