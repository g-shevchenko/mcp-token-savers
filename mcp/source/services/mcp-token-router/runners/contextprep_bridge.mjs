#!/usr/bin/env node
/**
 * Node bridge: read text on stdin, call context-prep-mcp prepText, emit
 * { compact_context, input_chars, output_chars, latency_ms } JSON on stdout.
 *
 * Used by the Python c2_bench runner (`contextprep_runner.py`) for
 * comparison against sophon at the same harness on the same fixtures.
 *
 * The bridge imports prepText directly from the local dist/ build of the
 * context-prep-mcp package. No MCP stdio JSON-RPC handshake required for
 * a deterministic measurement — this is the (str) → str contract that
 * c2_bench measures.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// Resolve context-prep-mcp dist/ relative to this bridge file.
// runners/contextprep_bridge.mjs → ../../context-prep-mcp/dist
// (both MCPs are siblings under the same services/ directory)
const CONTEXTPREP_DIST = path.resolve(
  __dirname, "..", "..", "context-prep-mcp", "dist",
);
const { prepText } = await import(path.join(CONTEXTPREP_DIST, "prep-text.js"));
const { getContextPrepConfig } = await import(path.join(CONTEXTPREP_DIST, "config.js"));

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

async function main() {
  const args = process.argv.slice(2);
  const maxCompactChars = parseInt(args[0] || "7000", 10);
  const preserveExact = args[1] === "true";
  const purpose = args[2] || "compact long text for frontier model context";

  const text = await readStdin();
  const config = getContextPrepConfig();
  const t0 = process.hrtime.bigint();
  const result = await prepText(text, config, {
    max_compact_chars: maxCompactChars,
    preserve_exact: preserveExact,
    purpose,
  });
  const t1 = process.hrtime.bigint();

  process.stdout.write(JSON.stringify({
    compact_context: result.compact_context,
    input_chars: text.length,
    output_chars: result.compact_context.length,
    latency_ms: Number((t1 - t0) / 1_000_000n),
  }));
}

main().catch((err) => {
  process.stderr.write(`contextprep_bridge error: ${err.message}\n${err.stack}\n`);
  process.exit(2);
});
