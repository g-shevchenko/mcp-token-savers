# code-diet-mcp — SPEC v0.1 (2026-08-05)

> Status: **design + scaffold**. Architecture Gate record for the new Code Profile MCP.
> Research basis: `notes/code_mcp_stack_research_2026-08-05.md` (internal repo),
> anti-pattern catalog in `notes/code_review_simplification_approaches_2026-08-05.md`.
> Public-surface work is gated by `moat-stack-moat-guard` — the moat (tuned thresholds,
> HWAI slop catalog, measured gates) NEVER ships to a public repo; only the generic
> detector skeleton + neutral docs do.

## 1. Mission

Give coding agents **deterministic, local, $0 evidence** for two things the market
does not ship as a first-class MCP:

1. **PR/diff review with risk scoring** (`review_diff`) — grounded in the real
   blast radius + static checks + quality budget, not LLM vibes.
2. **AI-code "diet"** (`detect_ai_slop`, `delete_first_report`, `simplification_plan`) —
   detect and propose removal of the specific bloat LLMs generate: abstraction bloat,
   guard-clause/fallback spam, unrequested files/exports, re-export plumbing, dead code.

Positioning vs the existing stack: `repo-hygiene-mcp` scans the **whole repo** for
cleanup candidates; `code-diet-mcp` is **diff-scoped and AI-slop-specific** — it answers
"what in *this change* can be deleted/simplified without losing behavior".

## 2. Architecture Gate decisions (contracts first, prompts last)

| Decision | Resolution |
|---|---|
| What the LLM may own | Only **rerank/narrate** in `review_diff` (turn deterministic findings into prose). Never detection. |
| What code must own | ALL detectors, risk scoring, deletion candidacy, budget gates. Deterministic, re-runnable, no network. |
| Reused HWAI assets | `language-graph-mcp` (blast radius), `static-analysis-mcp` (tsc/eslint/semgrep), `repo-quality-gate-mcp` (new-code budget), `repo-hygiene-mcp` (dead/dup/complexity primitives), `test-results-mcp`/`tdd-gate-mcp` (immutability). |
| Schemas / validators | Zod-free, hand-rolled JSON-schema tool contracts (matches existing services). Output validators per detector. Golden corpus = the benchmark fixtures (§5). |
| Runtime state | Local cache dir `$HOME/.hwai/code-diet-mcp/` (artifacts + request log). Aggregate-only Pantheon export. No raw code leaves the machine. |
| Proof gate = `accepted` | Measured benchmark (§5) passes: precision/recall floors on detectors + token-savings floor on compacted review output. |
| Human gate | Greg signs the detector threshold tune + the public-boundary decision before any public push. |

**Hard gate (test-immutability):** `simplification_plan` never proposes removing or
weakening a test. Deletion candidates exclude test files by default.

## 3. Tool surface (v0.1)

Profile-filterable via env `CODE_DIET_PROFILE` (`core` | `review` | `hygiene`) to cap
tool-list token bloat (Sverklo `SVERKLO_PROFILE` pattern: core 5 tools ≈ -81% tokens).

| Tool | Profile | What it returns (deterministic) |
|---|---|---|
| `review_diff` | core, review | Risk-scored findings for a diff/PR: changed symbols, blast-radius size, new-code-budget verdict, static-check deltas, AI-slop hits in the diff. LLM only reranks. |
| `detect_ai_slop` | core, hygiene | Hits per anti-pattern class (§4) with file:line, class id, confidence, suggested action. |
| `delete_first_report` | core, review, hygiene | "What in this diff/repo-slice can be deleted without losing behavior" — unreferenced new exports, dead branches, redundant guards, unused files. Behavior-preserving verdict tied to tests. |
| `simplification_plan` | hygiene | Ordered, reviewed simplification candidates with effort/risk/behavior-preservation note. No file changes. |
| `get_artifact` | all | Raw evidence for a compact finding (artifact file). |
| `get_measurement_report` | all | Daily savings/quality rollup (Pantheon-safe aggregate). |

`code-core` = `review_diff`, `detect_ai_slop`, `delete_first_report`, `get_artifact`, `get_measurement_report`.

## 4. Anti-pattern detector classes (deterministic)

Source: anti-slop/ponytail research. Each detector = one function returning typed
findings; each carries an id, a regex/AST heuristic, and a confidence. Thresholds are
the **moat** — shipped public only as generic defaults.

| ID | Class | Heuristic (deterministic) |
|---|---|---|
| CD01 | Abstraction bloat | New interface/abstract/factory with exactly 1 implementation and no polymorphic call site. |
| CD02 | Guard-clause / fallback spam | >N defensive `if (!x) return` / try-catch in a single function above the module baseline; redundant nested try/catch. |
| CD03 | Unrequested file / export | New exported symbol with 0 in-repo references (reuse `repo-hygiene` unused-code primitive, diff-scoped). |
| CD04 | Re-export plumbing | Barrel file (`index.ts`) that only re-exports without adding value; chain of ≥2 pure re-exports. |
| CD05 | Reinvention | New helper duplicating stdlib/installed-dep capability (left-pad class) or an existing repo util. |
| CD06 | Dead code in diff | Unreachable branch/never-true condition introduced by the diff. |

## 5. Benchmark (engineering-note backbone)

This benchmark IS the reproducible evidence for the public engineering note.
Deterministic, local, re-runnable: `npm run benchmark`.

**Corpus** — golden fixtures under `benchmarks/code-diet/corpus/`:
- **AI-slop set**: synthetic + real LLM-generated diffs with hand-labeled CD01–CD06 hits
  (answer key lives in `corpus/<case>/expected.json`, blind to the author per
  `blind-validation-when-author-contaminated`).
- **Clean set**: hand-written / human-reviewed diffs that must produce ~0 findings
  (false-positive floor).

**Metrics** (deterministic grader, `benchmarks/code-diet/grade.mjs`):
- Per-class **precision / recall** against `expected.json`.
- **False-positive rate** on the clean set (floor: ≤ target).
- **review_diff token savings**: raw diff+context tokens vs compact findings tokens
  (same measurement pattern as repo-hygiene token_savings).
- Thresholds tuned until floors pass; the tune is the moat.

**Acceptance (proof gate):** all detector classes meet precision/recall floors AND
review_diff token-savings ≥ target on the corpus. One blind re-run (fresh subagent,
no answer key) validates the tune generalizes (state the n caveat).

**Engineering note** (`docs/engineering/code-diet-benchmark.md`, public-bound):
method + corpus shape + measured numbers + comparison vs Serena/Sverklo/repo-hygiene.
Moat numbers (exact tuned thresholds) stay private; the note publishes the *approach*
and *floors*, not the moat values.

## 6. Public / private split (moat-guard)

| Ships PUBLIC (`g-shevchenko/hwai-code-savers` or similar) | Stays PRIVATE (moat) |
|---|---|
| Detector skeletons CD01–CD06 with **generic default** thresholds | **Tuned thresholds** per class |
| `review_diff` orchestration frame (deterministic parts) | HWAI **slop catalog** (curated real-world patterns) |
| Benchmark harness + corpus *shape* + clean set | HWAI **measured gates** + the answer-key corpus |
| Neutral README, verify-first install, local-only | Orchestration, Pantheon wiring, tenant tuning |

Before ANY public-bound commit: `node scripts/validators/no_moat_leak.mjs <paths>`
must report 0 HARD_FAIL; decision to publish is a fresh owner call, not assumed.

## 7. Four-agent surface parity (definition of done, internal)

- Manifest entry in `mcp/manifest.json` (`code-diet` profile + service registry).
- stdio `tools/list` proof (`scripts/smoke-local.sh`).
- Stable main-clone `dist/` path; register in all 4 IDE MCP configs only after the
  benchmark passes; `node scripts/check_agent_surface_parity.mjs --mcp code-diet-mcp` = 4/4.
- Pantheon catalog entry + aggregate-only measurement export.

## 8. Non-goals (v0.1)

- No auto-fix / auto-delete (advisory only; agents read exact files + run proof loops).
- No symbol-level EDIT/rename (that's Serena's job — opt-in, out of scope here).
- No network, no API keys, no LLM calls inside detectors.
- No public push in this phase (scaffold + benchmark first; publish is a later decision).
