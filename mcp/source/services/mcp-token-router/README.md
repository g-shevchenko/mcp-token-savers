# mcp-token-router

Measurement-driven routing MCP — picks the right deterministic compressor based on
input size + output budget. Routing rules are backed by the c2_bench measurement
program (see the [research article](https://gregshevchenko.com/research/mcp-stack-token-economy/)).

## Why

Three compressors with different Pareto regimes:

| Tier | Output budget | Winner | Measured quality / saving |
|---|---|---|---|
| Tight | ≤ 1000 chars | `hwai_v0_1_600c` | 67% / 94% |
| Medium | 1000–2500 chars | `hwai_v0_1_2000c` | **87% / 92%** (Pareto sweet-spot) |
| Generous | ≥ 2500 chars | `contextprep_7000c` | 93% / 60% |

Plus a deterministic inflation guard: inputs < 1000 chars route to `none`
(every compressor adds a fixed wrapper that inflates short inputs).

Routing is deterministic, no LLM in the path. The actual compression is delegated
to one of three measured primitives via subprocess to the bundled Python runners
in `runners/`.

## Runtime dependencies

- **Python 3** — for the compressor subprocess dispatch (`python3` by default,
  override via `MCP_TOKEN_ROUTER_PYTHON` env var)
- **mcp-sophon** (npm) — vendor compressor used by the `hwai_v0_1` and `sophon_*`
  routing tiers. Install: `npm install -g mcp-sophon`. Override binary path via
  `SOPHON_BIN` env var.
- **context-prep-mcp** — sibling MCP in this repo. The `contextprep_*` tier
  imports `prepText` from its built `dist/`. Build it: `cd ../context-prep-mcp && npm install && npm run build`.

## Tools

### `route_compression(text, budget_chars?, task_type?) → {decision, result}`

- `text` (required, string): raw input to compress.
- `budget_chars` (optional, int, default 2000): target output budget in chars.
- `task_type` (optional, enum): `"extract"` forces hwai (fact-extraction critical);
  `"summarize"` forces contextprep (extractive gist); `"general"` uses budget tier.

Returns JSON with:
```json
{
  "decision": {
    "compressor": "hwai_v0_1_2000c",
    "reason": "medium (Pareto sweet-spot) budget 2000c → ...",
    "budget_used_chars": 2000
  },
  "result": {
    "compressed": "...",
    "input_chars": 2824,
    "output_chars": 378,
    "saving_pct": 0.866,
    "latency_ms": 159
  }
}
```

### `list_routes() → {rules}`

Returns the measurement-backed routing-rule table for auditing.

## Install

Wired in all four agentic IDEs via the stack's `install.sh`:

```bash
./install.sh --profile=core   # includes mcp-token-router
```

Or manually point your agent config at `scripts/local-stdio.sh`:
- Claude Code: `~/.claude.json` `mcpServers`
- Cursor: `~/.cursor/mcp.json` `mcpServers`
- Codex: `~/.codex/config.toml` `[mcp_servers.mcp-token-router]`
- Windsurf: `~/.codeium/windsurf/mcp_config.json` `mcpServers`

The wrapper self-bootstraps: installs + builds on first run; honors
`NODE_BIN`/`NPM_BIN`/`MCP_TOKEN_ROUTER_PYTHON` overrides.

Restart agents after wiring so stdio configs reload.

## Build / test / smoke

```bash
cd services/mcp-token-router
npm install
npm test           # 14 routing-decision unit tests
npm run build      # outputs dist/

# stdio handshake proof
printf '%s\n%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"s","version":"0"}}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' \
  | bash scripts/local-stdio.sh | head -3
```

## Files

| File | Purpose |
|---|---|
| `src/router.ts` | Pure routing decision (deterministic, TDD-tested) |
| `src/dispatch.ts` | Subprocess dispatch to bundled Python runners |
| `src/index.ts` | MCP server (stdio transport) |
| `tests/router.test.mjs` | 14 unit tests, Node native runner |
| `scripts/local-stdio.sh` | Self-bootstrapping wrapper for all 4 agent configs |
| `runners/` | Bundled Python compressor implementations (hwai_compressor, sophon, contextprep) |

## Measurement basis

Routing rules are backed by the c2_bench measurement program — see the
[research article](https://gregshevchenko.com/research/mcp-stack-token-economy/)
for the full methodology, fixtures, and Pareto analysis.
