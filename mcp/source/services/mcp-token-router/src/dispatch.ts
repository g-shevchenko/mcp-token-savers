/**
 * Compressor dispatch layer — shells out to the measured Python primitives.
 *
 * Each compressor key in `ROUTING_RULES` maps to a subprocess invocation
 * that calls the corresponding implementation in the bundled runners/
 * directory. Pure orchestration; the actual compression logic lives in
 * already-tested Python modules (hwai_compressor.wrap_sophon / sophon_runner
 * / contextprep_runner).
 *
 * Why subprocess (not native Node)? Two reasons:
 *  - hwai_v0_1's fact extractor is in Python; porting to TS is v0.2 work.
 *  - context-prep's prepText is in TS but we want a SINGLE dispatch path,
 *    not a hybrid (some via import, others via subprocess).
 * Keeps the surface uniform and the source of truth in one language.
 *
 * The runners are bundled alongside this MCP (./runners/) so the package
 * is self-contained — no external repo path needed.
 *
 * External runtime dependencies:
 *  - sophon binary (npm install -g mcp-sophon) — for hwai_v0_1 and sophon_* compressors
 *  - context-prep-mcp dist/ — for contextprep_* compressors (set CONTEXTPREP_BRIDGE env)
 */
import { spawn } from "node:child_process";
import path from "node:path";

const RUNNERS_DIR = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
  "runners",
);
const RUNNERS_HWAI_DIR = path.join(RUNNERS_DIR, "hwai_compressor");
const PYTHON = process.env.MCP_TOKEN_ROUTER_PYTHON || "python3";

export interface CompressResult {
  compressed: string;
  inputChars: number;
  outputChars: number;
  savingPct: number;
  latencyMs: number;
}

/**
 * Invoke a Python helper that imports the named compressor and emits a
 * single-line JSON envelope on stdout.
 *
 * The helper is inline rather than a separate file so the MCP package
 * stays self-contained (one TypeScript source tree + the c2_bench Python
 * tree it depends on at runtime). This is intentional v0.1 scope.
 */
async function callPython(
  compressorKey: string,
  text: string,
): Promise<CompressResult> {
  const helper = `
import sys, json, time, os
sys.path.insert(0, ${JSON.stringify(RUNNERS_DIR)})
sys.path.insert(0, ${JSON.stringify(RUNNERS_HWAI_DIR)})

text = sys.stdin.read()
key = ${JSON.stringify(compressorKey)}

t0 = time.perf_counter()
if key.startswith("hwai_v0_1_"):
    from wrap_sophon import hwai_compress_v0_1
    budget = int(key.split("_")[-1].rstrip("c"))
    out = hwai_compress_v0_1(text, total_max_chars=budget)
elif key.startswith("contextprep_"):
    from contextprep_runner import compress_via_contextprep
    budget = int(key.split("_")[-1].rstrip("c"))
    out = compress_via_contextprep(text, max_compact_chars=budget)
elif key.startswith("sophon_"):
    from sophon_runner import compress_via_sophon
    budget = int(key.split("_")[-1].rstrip("t"))
    out = compress_via_sophon(text, max_tokens=budget)
elif key == "none":
    out = text
else:
    raise ValueError(f"unknown compressor key: {key}")
t1 = time.perf_counter()

in_chars = len(text)
out_chars = len(out)
saving_pct = 0.0 if in_chars == 0 else max(0.0, 1.0 - out_chars / in_chars)
print(json.dumps({
    "compressed": out,
    "inputChars": in_chars,
    "outputChars": out_chars,
    "savingPct": saving_pct,
    "latencyMs": (t1 - t0) * 1000.0,
}))
`;

  return new Promise((resolve, reject) => {
    const proc = spawn(PYTHON, ["-c", helper], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    proc.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code !== 0) {
        reject(
          new Error(
            `python helper exited ${code}: ${stderr.slice(0, 500)}`,
          ),
        );
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch (err) {
        reject(
          new Error(
            `failed to parse python helper output: ${err}; stdout=${stdout.slice(0, 200)}`,
          ),
        );
      }
    });
    proc.stdin.write(text);
    proc.stdin.end();
  });
}

export async function dispatchCompressor(
  compressorKey: string,
  text: string,
): Promise<CompressResult> {
  if (compressorKey === "none") {
    return {
      compressed: text,
      inputChars: text.length,
      outputChars: text.length,
      savingPct: 0,
      latencyMs: 0,
    };
  }
  return await callPython(compressorKey, text);
}
