#!/usr/bin/env node

import path from "node:path";
import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { getContextPrepConfig, CONTEXT_PREP_PIPELINE_VERSION } from "./config.js";
import { readArtifact } from "./artifact-store.js";
import { prepLogs } from "./prep-logs.js";
import { prepText } from "./prep-text.js";
import { prepUrl } from "./prep-url.js";
import { compressContext } from "./compress-context.js";
import { appendRequestLog } from "./request-log.js";
import { clampText } from "./text-utils.js";

const config = getContextPrepConfig();

const METADATA_SCHEMA = {
  type: "object",
  description:
    "Optional sidecar metadata for attribution and routing. Recommended fields: owner, project, surface, repo, branch, commit_sha, session_id.",
  properties: {
    owner: { type: "string" },
    project: { type: "string" },
    surface: { type: "string" },
    repo: { type: "string" },
    branch: { type: "string" },
    commit_sha: { type: "string" },
    session_id: { type: "string" },
    source: { type: "string" },
    traffic_class: {
      type: "string",
      enum: ["production_like", "proof_loop", "benchmark", "smoke", "e2e", "unknown"],
      description:
        "Optional traffic attribution for measurement reports. Use production_like for real workflows and proof_loop/benchmark/smoke/e2e for eval traffic.",
    },
  },
};

const PREP_LOGS_TOOL: Tool = {
  name: "prep_logs",
  description:
    "Compress long terminal, CI, build, test, or runtime logs into a compact debugging context. " +
    "Parser-first: extracts failing commands, top errors, stack frames, impacted files, likely root cause, and raw artifact URL. " +
    "Use automatically when pasted logs are long/noisy. Do not use for short outputs where raw text is already readable.",
  inputSchema: {
    type: "object",
    properties: {
      text: {
        type: "string",
        description: "Raw terminal/CI/build/test/runtime log text.",
      },
      context: {
        type: "string",
        description: "Optional task context, e.g. npm build on Astro site or Playwright regression run.",
      },
      max_compact_chars: {
        type: "number",
        description: "Maximum compact context characters. Default: 8000.",
      },
      metadata: METADATA_SCHEMA,
    },
    required: ["text"],
  },
};

const PREP_URL_TOOL: Tool = {
  name: "prep_url",
  description:
    "Fetch and clean a public URL into compact LLM-ready markdown with title, canonical URL, headings, key facts, links, warnings, and cleaned artifact URL. " +
    "Parser-first and SSRF-guarded. Use for specific URLs the user asks the agent to read or compare. " +
    "Do not use as a replacement for web search when the task needs latest/open-ended research.",
  inputSchema: {
    type: "object",
    properties: {
      url: {
        type: "string",
        description: "Public http/https URL to fetch and compact.",
      },
      purpose: {
        type: "string",
        description: "Optional goal, e.g. research, landing-page-audit, extract-pricing, summarize.",
      },
      max_compact_chars: {
        type: "number",
        description: "Maximum compact markdown characters. Default: 9000.",
      },
      parser_stack: {
        type: "string",
        enum: ["auto", "local", "scraper_core"],
        default: "auto",
        description:
          "URL parser path. auto = cheap local parser first, then scraper-core fallback on JS/challenge/low extraction. local = never call scraper-core. scraper_core = force HWAI scraper-core /fetch.",
      },
      max_tier: {
        type: "string",
        description:
          "Optional scraper-core escalation ceiling for fallback/forced mode. Default comes from service env, usually camoufox. Paid tiers are clamped unless allow_paid_tiers=true.",
      },
      allow_paid_tiers: {
        type: "boolean",
        default: false,
        description: "Allow scraper-core paid/proxy tiers when caller explicitly accepts cost. Default false.",
      },
      country: {
        type: "string",
        description: "Optional scraper-core geo hint, e.g. US, GB, AE.",
      },
      session_id: {
        type: "string",
        description:
          "Optional scraper-core sticky-session key for batches or same-domain flows. Helps cache/fingerprint reuse.",
      },
      metadata: METADATA_SCHEMA,
    },
    required: ["url"],
  },
};

const PREP_TEXT_TOOL: Tool = {
  name: "prep_text",
  description:
    "Turn a long pasted text, meeting notes, handoff, spec, or chat history into compact carry-forward context. " +
    "Extracts summary lines, decisions, action items, open questions, risks, and raw artifact URL. " +
    "Use when the pasted text is large enough that sending it raw would waste frontier context.",
  inputSchema: {
    type: "object",
    properties: {
      text: {
        type: "string",
        description: "Raw long text to compact.",
      },
      purpose: {
        type: "string",
        description: "Optional goal, e.g. build handoff, summarize decisions, extract action items.",
      },
      max_compact_chars: {
        type: "number",
        description: "Maximum compact context characters. Default: 7000.",
      },
      preserve_exact: {
        type: "boolean",
        description:
          "Use less aggressive compaction when exact wording matters. This may spend more tokens but reduces quality risk.",
      },
      metadata: METADATA_SCHEMA,
    },
    required: ["text"],
  },
};

const COMPRESS_CONTEXT_TOOL: Tool = {
  name: "compress_context",
  description:
    "Query-aware or general deterministic context compression. Local-first, extractive, and API-free. " +
    "Use for long retrieved documents, tool outputs, or reusable context when prep_text is too summary-oriented and answer-critical evidence must be retained. " +
    "If exact wording matters or confidence is high-risk, fetch the raw artifact.",
  inputSchema: {
    type: "object",
    properties: {
      text: {
        type: "string",
        description: "Raw long context to compress.",
      },
      query: {
        type: "string",
        description: "Optional query or task intent. Strongly recommended in query mode.",
      },
      mode: {
        type: "string",
        enum: ["query", "general"],
        default: "query",
        description: "query = keep query-relevant evidence; general = preserve broadly important chunks.",
      },
      target_ratio: {
        type: "number",
        description: "Target kept-token ratio, clamped to 0.1-0.9. Default: 0.35.",
      },
      metadata: METADATA_SCHEMA,
    },
    required: ["text"],
  },
};

const GET_ARTIFACT_TOOL: Tool = {
  name: "get_artifact",
  description:
    "Read a text/json/markdown/log artifact produced by context-prep-mcp. Use when compact output is uncertain or exact wording is needed.",
  inputSchema: {
    type: "object",
    properties: {
      artifact_url_or_file: {
        type: "string",
        description: "Artifact URL or file name from a previous context-prep-mcp response.",
      },
      max_chars: {
        type: "number",
        description: "Maximum returned characters. Default: 20000.",
      },
    },
    required: ["artifact_url_or_file"],
  },
};

const RUNTIME_DIAGNOSTICS_TOOL: Tool = {
  name: "get_runtime_diagnostics",
  description:
    "Return metadata-only runtime diagnostics for context-prep-mcp configuration. " +
    "Use when prep_url fails on scraper-core fallback, 403/JS/challenge pages, or when deciding whether this is a code bug versus env/config drift.",
  inputSchema: {
    type: "object",
    properties: {},
  },
};

function toolError(message: string) {
  return {
    content: [{ type: "text" as const, text: message }],
    isError: true,
  };
}

function stringifyResult(payload: unknown): string {
  return JSON.stringify(payload, null, 2);
}

function asText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asParserStack(value: unknown): "auto" | "local" | "scraper_core" | undefined {
  return value === "auto" || value === "local" || value === "scraper_core" ? value : undefined;
}

function artifactFileName(raw: string): string {
  try {
    const parsed = new URL(raw);
    return path.basename(parsed.pathname);
  } catch {
    return path.basename(raw);
  }
}

function safeUrlHost(raw: unknown): string | undefined {
  if (typeof raw !== "string") {
    return undefined;
  }

  try {
    return new URL(raw).host;
  } catch {
    return undefined;
  }
}

function runtimeDiagnostics(): Record<string, unknown> {
  const scraperConfigured = Boolean(config.scraperCoreKey);
  const warnings: string[] = [];
  const recommendedActions: string[] = [];

  if (config.scraperFallbackMode !== "disabled" && !scraperConfigured) {
    warnings.push("scraper_core_fallback_key_missing");
    recommendedActions.push(
      "Set CONTEXT_PREP_SCRAPER_KEY when prep_url must handle 403, JS challenge, or low-extraction pages.",
    );
  }

  if (!config.allowAnyUrl && config.allowedHosts.length === 0) {
    warnings.push("url_policy_all_hosts_blocked");
    recommendedActions.push("Set CONTEXT_PREP_ALLOWED_HOSTS or enable CONTEXT_PREP_ALLOW_ANY_URL for intended public URL reads.");
  }

  return {
    schema_version: "context-prep-runtime-diagnostics.v1",
    service: "context-prep-mcp",
    ok: warnings.length === 0,
    url_policy: {
      allow_any_url: config.allowAnyUrl,
      allowed_hosts_count: config.allowedHosts.length,
      allowed_hosts: config.allowedHosts,
      allow_private_urls: config.allowPrivateUrls,
    },
    scraper_core: {
      configured: scraperConfigured,
      fallback_mode: config.scraperFallbackMode,
      max_tier: config.scraperMaxTier,
      url_host: safeUrlHost(config.scraperCoreUrl),
      key_env_candidates: ["CONTEXT_PREP_SCRAPER_KEY"],
    },
    warnings,
    recommended_actions: recommendedActions,
    data_policy: {
      includes_secret_values: false,
      includes_raw_urls: false,
      includes_artifact_urls: false,
    },
  };
}

function metadataSource(args: Record<string, unknown>): string | undefined {
  const metadata = args.metadata;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return undefined;
  }

  const source = (metadata as Record<string, unknown>).source;
  return typeof source === "string" && source.trim() ? source.trim().slice(0, 80) : undefined;
}

function metadataSurface(args: Record<string, unknown>): string | undefined {
  const metadata = args.metadata;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return undefined;
  }

  const surface = (metadata as Record<string, unknown>).surface;
  return typeof surface === "string" && surface.trim() ? surface.trim().slice(0, 80) : undefined;
}

function metadataTrafficClass(args: Record<string, unknown>): string | undefined {
  const metadata = args.metadata;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return undefined;
  }

  const trafficClass = (metadata as Record<string, unknown>).traffic_class;
  return typeof trafficClass === "string" && trafficClass.trim() ? trafficClass.trim().slice(0, 80) : undefined;
}

function summarizeInput(tool: string, args: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!args) {
    return {};
  }

  if (tool === "prep_url") {
    return {
      url_host: safeUrlHost(args.url),
      parser_stack: args.parser_stack,
      max_tier: args.max_tier,
      allow_paid_tiers: Boolean(args.allow_paid_tiers),
      purpose: typeof args.purpose === "string" ? clampText(args.purpose, 160) : undefined,
      metadata_source: metadataSource(args),
      metadata_surface: metadataSurface(args),
      traffic_class: metadataTrafficClass(args),
    };
  }

  if (tool === "prep_logs" || tool === "prep_text" || tool === "compress_context") {
    return {
      text_chars: typeof args.text === "string" ? args.text.length : 0,
      max_compact_chars: args.max_compact_chars,
      purpose: typeof args.purpose === "string" ? clampText(args.purpose, 160) : undefined,
      context: typeof args.context === "string" ? clampText(args.context, 160) : undefined,
      query: typeof args.query === "string" ? clampText(args.query, 160) : undefined,
      mode: args.mode,
      target_ratio: args.target_ratio,
      preserve_exact: Boolean(args.preserve_exact),
      metadata_source: metadataSource(args),
      metadata_surface: metadataSurface(args),
      traffic_class: metadataTrafficClass(args),
    };
  }

  if (tool === "get_artifact") {
    return {
      artifact_file: typeof args.artifact_url_or_file === "string" ? artifactFileName(args.artifact_url_or_file) : undefined,
      max_chars: args.max_chars,
    };
  }

  return {};
}

function summarizeOutput(result: unknown): Record<string, unknown> {
  if (!result || typeof result !== "object") {
    return {};
  }

  const record = result as Record<string, any>;
  return {
    prep_mode: record.prep_mode,
    raw_tokens_estimate: record.input_stats?.raw_tokens_estimate,
    compact_tokens_estimate: record.input_stats?.compact_tokens_estimate,
    saved_tokens_estimate: record.input_stats?.saved_tokens_estimate,
    savings_pct: record.input_stats?.savings_pct,
    warnings_count: Array.isArray(record.warnings) ? record.warnings.length : undefined,
    uncertainty: record.confidence?.uncertainty,
    requires_clarification: record.autopilot?.requires_clarification === true,
    parser_requested: record.parser_stack?.requested,
    parser_used: record.parser_stack?.used,
    scraper_fallback_reason: record.parser_stack?.fallback_reason,
    scraper_engine: record.parser_stack?.scraper_core?.engine,
    compression_mode: record.compression?.mode,
    compression_method: record.compression?.method,
    compression_target_ratio: record.compression?.target_ratio,
    units_total: record.compression?.units_total,
    units_kept: record.compression?.units_kept,
  };
}

async function audited<T>(
  tool: string,
  transport: "mcp" | "rest" | "http",
  args: Record<string, unknown> | undefined,
  run: () => Promise<T>,
): Promise<T> {
  const started = Date.now();

  try {
    const result = await run();
    await appendRequestLog(config, {
      tool,
      transport,
      ok: true,
      duration_ms: Date.now() - started,
      input: summarizeInput(tool, args),
      output: summarizeOutput(result),
    });
    return result;
  } catch (error) {
    await appendRequestLog(config, {
      tool,
      transport,
      ok: false,
      duration_ms: Date.now() - started,
      input: summarizeInput(tool, args),
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

function createContextPrepServer(): Server {
  const server = new Server(
    {
      name: "hwai-context-prep-mcp",
      version: "1.0.0",
    },
    {
      capabilities: {
        tools: {},
      },
      instructions:
        "Use context-prep tools only for large/noisy inputs: logs, concrete URLs, or long pasted text. Prefer compact outputs, but inspect artifacts when exact wording or confidence matters. This service prepares context; it does not replace frontier reasoning.",
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: [PREP_LOGS_TOOL, PREP_URL_TOOL, PREP_TEXT_TOOL, COMPRESS_CONTEXT_TOOL, GET_ARTIFACT_TOOL, RUNTIME_DIAGNOSTICS_TOOL],
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    if (name === "get_runtime_diagnostics") {
      const result = await audited(name, "mcp", args as Record<string, unknown> | undefined, async () =>
        runtimeDiagnostics(),
      );
      return { content: [{ type: "text" as const, text: stringifyResult(result) }] };
    }

    if (name === "prep_logs") {
      const text = asText(args?.text);
      if (!text) {
        return toolError("Error: text is required");
      }

      try {
        const result = await audited("prep_logs", "mcp", args as Record<string, unknown> | undefined, async () =>
          prepLogs(text, config, {
            context: asText(args?.context),
            max_compact_chars: args?.max_compact_chars as number | undefined,
            metadata: args?.metadata,
          }),
        );
        return { content: [{ type: "text" as const, text: stringifyResult(result) }] };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        return toolError(`Error preparing logs: ${errorMessage}`);
      }
    }

    if (name === "prep_url") {
      const url = asText(args?.url);
      if (!url) {
        return toolError("Error: url is required");
      }

      try {
        const result = await audited("prep_url", "mcp", args as Record<string, unknown> | undefined, async () =>
          prepUrl(url, config, {
            purpose: asText(args?.purpose),
            max_compact_chars: args?.max_compact_chars as number | undefined,
            parser_stack: asParserStack(args?.parser_stack),
            max_tier: asText(args?.max_tier) || undefined,
            allow_paid_tiers: Boolean(args?.allow_paid_tiers),
            country: asText(args?.country) || undefined,
            session_id: asText(args?.session_id) || undefined,
            metadata: args?.metadata,
          }),
        );
        return { content: [{ type: "text" as const, text: stringifyResult(result) }] };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        return toolError(`Error preparing URL: ${errorMessage}`);
      }
    }

    if (name === "prep_text") {
      const text = asText(args?.text);
      if (!text) {
        return toolError("Error: text is required");
      }

      try {
        const result = await audited("prep_text", "mcp", args as Record<string, unknown> | undefined, async () =>
          prepText(text, config, {
            purpose: asText(args?.purpose),
            max_compact_chars: args?.max_compact_chars as number | undefined,
            preserve_exact: Boolean(args?.preserve_exact),
            metadata: args?.metadata,
          }),
        );
        return { content: [{ type: "text" as const, text: stringifyResult(result) }] };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        return toolError(`Error preparing text: ${errorMessage}`);
      }
    }

    if (name === "compress_context") {
      const text = asText(args?.text);
      if (!text) {
        return toolError("Error: text is required");
      }

      try {
        const result = await audited("compress_context", "mcp", args as Record<string, unknown> | undefined, async () =>
          compressContext(text, config, {
            query: asText(args?.query),
            mode: args?.mode === "general" ? "general" : "query",
            target_ratio: args?.target_ratio as number | undefined,
            metadata: args?.metadata,
          }),
        );
        return { content: [{ type: "text" as const, text: stringifyResult(result) }] };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        return toolError(`Error compressing context: ${errorMessage}`);
      }
    }

    if (name === "get_artifact") {
      const raw = asText(args?.artifact_url_or_file);
      const maxChars = (args?.max_chars as number) || 20_000;
      if (!raw) {
        return toolError("Error: artifact_url_or_file is required");
      }

      try {
        const artifact = await audited("get_artifact", "mcp", args as Record<string, unknown> | undefined, async () =>
          readArtifact(config, artifactFileName(raw)),
        );
        if (!artifact) {
          return toolError("Error: artifact not found");
        }

        return {
          content: [
            {
              type: "text" as const,
              text: clampText(artifact.toString("utf8"), maxChars),
            },
          ],
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        return toolError(`Error reading artifact: ${errorMessage}`);
      }
    }

    return toolError(`Unknown tool: ${name}`);
  });

  return server;
}

function respondJson(res: ServerResponse, statusCode: number, payload: unknown): void {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
}

async function parseBody(req: IncomingMessage, maxBytes = config.maxBodyBytes): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;

  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > maxBytes) {
      throw new Error(`Request body exceeds maximum allowed size (${maxBytes} bytes)`);
    }
    chunks.push(buffer);
  }

  if (chunks.length === 0) {
    return undefined;
  }

  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function handleMcpHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== "POST") {
    respondJson(res, 405, {
      jsonrpc: "2.0",
      error: {
        code: -32000,
        message: "Method not allowed.",
      },
      id: null,
    });
    return;
  }

  const server = createContextPrepServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });

  try {
    const parsedBody = await parseBody(req);
    await server.connect(transport);
    await transport.handleRequest(req, res, parsedBody);
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
  } catch (error) {
    console.error("Error handling HTTP MCP request:", error);
    if (!res.headersSent) {
      respondJson(res, 500, {
        jsonrpc: "2.0",
        error: {
          code: -32603,
          message: "Internal server error",
        },
        id: null,
      });
    }
    await transport.close();
    await server.close();
  }
}

async function handleRestPrep(pathname: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== "POST") {
    respondJson(res, 405, { error: "Method not allowed" });
    return;
  }

  const body = (await parseBody(req)) as Record<string, unknown> | undefined;
  if (!body) {
    respondJson(res, 400, { error: "JSON body is required" });
    return;
  }

  if (pathname === "/api/prep/logs") {
    respondJson(
      res,
      200,
      await audited("prep_logs", "rest", body, async () =>
        prepLogs(asText(body.text), config, {
          context: asText(body.context),
          max_compact_chars: body.max_compact_chars as number | undefined,
          metadata: body.metadata,
        }),
      ),
    );
    return;
  }

  if (pathname === "/api/prep/url") {
    respondJson(
      res,
      200,
      await audited("prep_url", "rest", body, async () =>
        prepUrl(asText(body.url), config, {
          purpose: asText(body.purpose),
          max_compact_chars: body.max_compact_chars as number | undefined,
          parser_stack: asParserStack(body.parser_stack),
          max_tier: asText(body.max_tier) || undefined,
          allow_paid_tiers: Boolean(body.allow_paid_tiers),
          country: asText(body.country) || undefined,
          session_id: asText(body.session_id) || undefined,
          metadata: body.metadata,
        }),
      ),
    );
    return;
  }

  if (pathname === "/api/prep/text") {
    respondJson(
      res,
      200,
      await audited("prep_text", "rest", body, async () =>
        prepText(asText(body.text), config, {
          purpose: asText(body.purpose),
          max_compact_chars: body.max_compact_chars as number | undefined,
          preserve_exact: Boolean(body.preserve_exact),
          metadata: body.metadata,
        }),
      ),
    );
    return;
  }

  if (pathname === "/api/prep/compress") {
    respondJson(
      res,
      200,
      await audited("compress_context", "rest", body, async () =>
        compressContext(asText(body.text), config, {
          query: asText(body.query),
          mode: body.mode === "general" ? "general" : "query",
          target_ratio: body.target_ratio as number | undefined,
          metadata: body.metadata,
        }),
      ),
    );
    return;
  }

  respondJson(res, 404, { error: "Unknown prep endpoint" });
}

async function startHttpServer(): Promise<void> {
  const httpServer = createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", `http://${req.headers.host || "127.0.0.1"}`);

      if (url.pathname === "/health") {
        respondJson(res, 200, {
          ok: true,
          service: "context-prep-mcp",
          cache_dir: config.cacheDir,
          artifact_dir: config.artifactDir,
          request_log_path: config.requestLogPath,
          public_base_url: config.publicBaseUrl,
          transport_mode: "http",
          prep_modes: ["logs-prep", "url-prep", "text-prep", "context-compression"],
          pipeline_version: CONTEXT_PREP_PIPELINE_VERSION,
          max_body_bytes: config.maxBodyBytes,
          max_input_chars: config.maxInputChars,
          allow_any_url: config.allowAnyUrl,
          allowed_hosts: config.allowedHosts,
          allow_private_urls: config.allowPrivateUrls,
          scraper_core: {
            configured: Boolean(config.scraperCoreKey),
            fallback_mode: config.scraperFallbackMode,
            max_tier: config.scraperMaxTier,
            url: config.scraperCoreUrl,
          },
        });
        return;
      }

      if (url.pathname.startsWith("/artifacts/")) {
        const fileName = path.basename(url.pathname.replace("/artifacts/", ""));
        const artifact = await readArtifact(config, fileName);

        if (!artifact) {
          respondJson(res, 404, { error: "Artifact not found" });
          return;
        }

        const ext = path.extname(fileName).toLowerCase();
        const contentType =
          ext === ".json"
            ? "application/json; charset=utf-8"
            : ext === ".md"
              ? "text/markdown; charset=utf-8"
              : "text/plain; charset=utf-8";

        res.statusCode = 200;
        res.setHeader("Content-Type", contentType);
        res.setHeader("Cache-Control", "public, max-age=604800, immutable");
        res.end(artifact);
        return;
      }

      if (url.pathname === "/mcp") {
        await handleMcpHttp(req, res);
        return;
      }

      if (url.pathname.startsWith("/api/prep/")) {
        await handleRestPrep(url.pathname, req, res);
        return;
      }

      respondJson(res, 404, { error: "Not found" });
    } catch (error) {
      console.error("HTTP server error:", error);
      if (!res.headersSent) {
        const message = error instanceof Error ? error.message : "Internal server error";
        respondJson(res, 500, { error: message });
      }
    }
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(config.httpPort, config.httpHost, () => resolve());
  });

  console.error(
    `HWAI Context Prep MCP Server running on HTTP http://${config.httpHost}:${config.httpPort}/mcp`,
  );
}

async function startStdioServer(): Promise<void> {
  const server = createContextPrepServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("HWAI Context Prep MCP Server running on stdio");
}

async function main(): Promise<void> {
  if (config.transportMode === "http") {
    await startHttpServer();
    return;
  }

  await startStdioServer();
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
