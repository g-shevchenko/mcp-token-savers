# Visual Baseline MCP

Local-first screenshot baseline and pixel-diff MCP for HWAI agents.

## Goal

`visual-baseline-mcp` catches obvious visual regressions before a frontier vision model sees a screenshot. It stores named local baselines, compares candidate screenshots with a changed-pixel budget, writes local diff artifacts, and logs only safe aggregates for measurement.

This is not a paid visual-testing cloud. It is the cheap first pass that should answer: "Did the UI materially change, and is a human/frontier model worth spending tokens on?"

## Local stdio

```bash
services/visual-baseline-mcp/scripts/local-stdio.sh
```

Default durable cache:

```bash
$HOME/.hwai/visual-baseline-mcp
```

Durable trace:

```bash
$HOME/.hwai/visual-baseline-mcp/requests.jsonl
```

`local-stdio.sh` resolves `node` and `npm` from `NODE_BIN` / `NPM_BIN`, the active `PATH`, then common Homebrew/system paths. `npm run smoke` includes a reduced-`PATH` stdio proof so client-launched MCP sessions do not depend on an interactive shell environment.

## Tools

- `create_baseline` stores a normalized PNG baseline under the local cache.
- `approve_baseline` writes a local approval manifest for the current baseline.
- `save_mask_preset` stores reusable local rectangle ignore masks for dynamic regions, optionally scoped by route/component/viewport/tags.
- `compare_screenshot` compares a candidate screenshot against a named baseline and returns changed-pixel budget results plus local diff artifacts.
- `get_artifact` reads local artifacts produced by this MCP.
- `get_measurement_report` returns usage, quality counters, savings estimates, and Pantheon-safe aggregate export.

## Data Policy

- Raw screenshots stay local.
- Raw image paths are not written to request logs.
- Mask preset names and scope values stay local; request logs store only counts/booleans for preset and query use.
- Pantheon exports are aggregate-only and exclude raw images, local paths, image URLs, artifact URLs, and pixel samples.
- Notification reporting is not enabled.

## Proof Loop

```bash
cd services/visual-baseline-mcp
npm install
npm run build
npm run benchmark
npm run benchmark:hwai-verify
npm run benchmark:cdn
npm run smoke
node scripts/measurement-report.mjs --date=2026-04-24 --format=pantheon
cd ../..
node scripts/hwai-playwright-visual-baseline-proof.mjs --out=/tmp/hwai-playwright-visual-baseline-proof-2026-04-24-scope-query.json
```

The local benchmark covers:

- baseline creation
- local baseline approval manifest creation
- approved compare status
- unchanged screenshot pass
- changed screenshot detection
- dynamic-region ignore masks
- reusable mask presets
- scoped mask-preset queries by route/component/viewport/tag metadata
- dimension mismatch detection
- measurement aggregation
- aggregate-only Pantheon export policy

The Playwright bridge proof validates generated `trace.zip`/HAR/screenshot artifacts flowing into local baseline approval and comparison without exporting raw image paths or artifact URLs to Pantheon-safe output.

Latest local proof on 2026-04-24:

- golden benchmark: 29 cases, 0 failures, including stale approval detection, reusable mask presets, and scoped mask-preset query matching
- bridge proof: baseline approval plus same/changed/explicit-mask/preset-mask/scoped-query/dimension comparison, 9 visual measurement calls, 6,737,278 saved-token estimate in temp cache
- HWAI verify screenshot proof: local `.artifacts/hwai-verify` screenshot -> baseline approval -> changed/scoped-query masked pass, 6 local measurement calls, 6,879,779 saved-token estimate in temp cache
- expanded screenshot proof: public sample screenshots -> local download -> baseline approval -> changed/scoped-query masked pass; request logs and central-safe export contain only hashes/counts, not raw screenshot URLs, URL paths, image paths, or scope values
- durable service sample: 39 requests, 0 errors, 9 baselines created, 3 approvals recorded, 2 mask presets saved, 16 compares, 9 approved compares
- visual counters: 1,296 counted changed pixels, 1,008 ignored changed pixels, 3 preset-applied compares, and 1 scoped preset-query match
- saved-token estimate: 73,688, with 98.8% proof/instrumentation savings

## Commercial Analogs

This MCP replaces only the first local layer of products such as Percy, Applitools, Chromatic, and Happo:

- pixel-diff budget before human/model review
- local diff artifacts
- deterministic proof loops
- measurement of avoided screenshot-token spend

It does not yet replace commercial strengths such as hosted review UI, multi-browser cloud farms, branch approvals, flake triage, visual AI layout matching, or team permission workflows. Local approval manifests and scoped mask presets are intentionally file-backed and aggregate-measured; richer review UX should be added only when local benchmark cases prove value.

## Next Hardening

1. Promote generated Playwright bridge proof into real failed HWAI UI trace fixtures.
2. Keep expanding local HWAI verify and CDN screenshot fixtures into a reviewed route/component/viewport fixture set as new real UI-review cases appear.
3. Expand file-backed approval manifests with branch/PR summary output.
4. Add snapshot manifests per route/component/viewport.
5. Add auto-mask discovery only if repeated dynamic-region false positives appear in reviewed fixtures.
6. Add perceptual diff mode only if pixel diff produces noisy misses.
7. Add PR-ready summary linking Playwright failure window, visual diff status, and agent trace.
