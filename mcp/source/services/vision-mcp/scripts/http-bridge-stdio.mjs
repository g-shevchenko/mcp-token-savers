#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const DEFAULT_REMOTE_BASE_URL = "http://127.0.0.1:3393";

function parsePositiveInt(rawValue, fallback) {
  const parsed = Number(rawValue);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function buildRemoteUrls() {
  const publicBase =
    process.env.VISION_REMOTE_PUBLIC_BASE_URL ||
    process.env.VISION_MCP_PUBLIC_BASE_URL ||
    DEFAULT_REMOTE_BASE_URL;
  const normalizedBase = publicBase.replace(/\/+$/, "");
  const mcpUrl = process.env.VISION_MCP_URL || `${normalizedBase}/mcp`;
  const healthUrl = process.env.VISION_MCP_HEALTH_URL || `${normalizedBase}/health`;

  return {
    publicBase: normalizedBase,
    mcpUrl,
    healthUrl,
  };
}

const transportConfig = {
  ...buildRemoteUrls(),
  requestTimeoutMs: parsePositiveInt(process.env.VISION_MCP_BRIDGE_TIMEOUT_MS, 30000),
};

let nextId = 1;
let cachedTools = null;

function parseJsonResponse(text) {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`Failed to parse JSON response from remote MCP: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function parseSseResponse(text) {
  const events = [];
  let currentData = [];

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trimEnd();

    if (!line) {
      if (currentData.length) {
        events.push(currentData.join("\n"));
        currentData = [];
      }
      continue;
    }

    if (line.startsWith("data:")) {
      currentData.push(line.slice(5).trimStart());
    }
  }

  if (currentData.length) {
    events.push(currentData.join("\n"));
  }

  for (let index = events.length - 1; index >= 0; index -= 1) {
    const candidate = events[index];
    if (!candidate || candidate === "[DONE]") {
      continue;
    }

    try {
      return JSON.parse(candidate);
    } catch {
      // Keep looking for the last parseable JSON event.
    }
  }

  throw new Error("Failed to parse SSE response from remote MCP");
}

async function remoteMcpRequest(method, params) {
  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), transportConfig.requestTimeoutMs);

  try {
    const response = await fetch(transportConfig.mcpUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: nextId++,
        method,
        params,
      }),
      signal: controller.signal,
    });

    const responseText = await response.text();

    if (!response.ok) {
      throw new Error(`Remote MCP HTTP ${response.status}: ${responseText.slice(0, 400)}`);
    }

    const contentType = response.headers.get("content-type") || "";
    const payload = contentType.includes("text/event-stream")
      ? parseSseResponse(responseText)
      : parseJsonResponse(responseText);

    if (payload?.error) {
      throw new Error(`Remote MCP ${method} error: ${payload.error.message || JSON.stringify(payload.error)}`);
    }

    return payload?.result;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`Remote MCP ${method} timed out after ${transportConfig.requestTimeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeoutHandle);
  }
}

async function preflightHealthCheck() {
  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), 5000);

  try {
    const response = await fetch(transportConfig.healthUrl, {
      headers: { accept: "application/json" },
      signal: controller.signal,
    });

    if (!response.ok) {
      console.error(
        `[vision-mcp bridge] health preflight returned HTTP ${response.status} from ${transportConfig.healthUrl}`,
      );
      return;
    }

    console.error(
      `[vision-mcp bridge] remote HTTP health OK: ${transportConfig.healthUrl}`,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(
      `[vision-mcp bridge] health preflight failed for ${transportConfig.healthUrl}: ${message}`,
    );
  } finally {
    clearTimeout(timeoutHandle);
  }
}

function createBridgeServer() {
  const server = new Server(
    {
      name: "hwai-vision-mcp-http-bridge",
      version: "1.0.0",
    },
    {
      capabilities: {
        tools: {},
      },
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    try {
      const result = await remoteMcpRequest("tools/list", {});
      const tools = Array.isArray(result?.tools) ? result.tools : [];
      cachedTools = tools;
      return { tools };
    } catch (error) {
      if (cachedTools) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(
          `[vision-mcp bridge] tools/list failed, falling back to cached tool metadata: ${message}`,
        );
        return { tools: cachedTools };
      }
      throw error;
    }
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      return await remoteMcpRequest("tools/call", request.params);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [
          {
            type: "text",
            text:
              `Vision MCP bridge error: ${message}\n` +
              `Remote MCP URL: ${transportConfig.mcpUrl}\n` +
              `Health URL: ${transportConfig.healthUrl}\n` +
              `Run the repo smoke commands before retrying the tool.`,
          },
        ],
        isError: true,
      };
    }
  });

  return server;
}

async function main() {
  await preflightHealthCheck();

  const server = createBridgeServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error(
    `[vision-mcp bridge] stdio bridge ready -> ${transportConfig.mcpUrl}`,
  );
}

main().catch((error) => {
  console.error("[vision-mcp bridge] fatal error:", error);
  process.exit(1);
});
