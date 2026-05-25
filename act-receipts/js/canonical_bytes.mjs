/**
 * scraper-mcp.act_receipt.v1 — JavaScript reference implementation.
 *
 * Companion to https://gregshevchenko.com/research/mcp-stack-token-economy-part-2/
 *
 * Cross-runtime equivalent of `../python/act_receipts.py`. Produces the
 * SAME canonical bytes and SAME SHA-256 for the same receipt object.
 *
 * If JS and Python ever disagree on a single byte, the whole cache-
 * friendliness design breaks — verified in `canonical_bytes.test.mjs`
 * against shared golden fixtures.
 *
 * Algorithm (mirrors Python):
 *   1. Take a dict copy of the receipt
 *   2. Drop the top-level `observability` subtree
 *   3. Drop `dom_region_size_bytes` from `pre_state` and `post_state`
 *   4. `json.dumps(sort_keys=True, ensure_ascii=False).encode("utf-8")`
 *
 * JSON serialization parity:
 *   - sort_keys=True       -> recursive sortedJsonStringify below
 *   - ensure_ascii=False   -> JSON.stringify is non-escaping for
 *                            non-ASCII by default (matches Python's
 *                            ensure_ascii=False — both emit raw UTF-8).
 *   - separators           -> Python's json.dumps default is
 *                            (", ", ": ") with spaces; JS
 *                            JSON.stringify default is ",", ":" without
 *                            spaces. We force JS to match Python by
 *                            emitting `, ` and `: ` manually.
 *
 * License: MIT
 */
import { createHash } from "node:crypto";

const STRIPPED_TOP_KEYS = new Set(["observability"]);
const STATE_KEYS = new Set(["pre_state", "post_state"]);
const STRIPPED_STATE_KEYS = new Set(["dom_region_size_bytes"]);

/**
 * Return a copy of `receipt` with jitter fields stripped:
 *   - observability subtree gone
 *   - dom_region_size_bytes gone from pre_state + post_state
 */
function stripForCanonical(receipt) {
  const cleaned = {};
  for (const [key, value] of Object.entries(receipt)) {
    if (STRIPPED_TOP_KEYS.has(key)) continue;
    if (
      STATE_KEYS.has(key) &&
      value !== null &&
      typeof value === "object" &&
      !Array.isArray(value)
    ) {
      const sub = {};
      for (const [k, v] of Object.entries(value)) {
        if (!STRIPPED_STATE_KEYS.has(k)) sub[k] = v;
      }
      cleaned[key] = sub;
    } else {
      cleaned[key] = value;
    }
  }
  return cleaned;
}

/**
 * Recursive JSON stringify with sorted object keys and Python's default
 * separators ("," + " " and ":" + " "). Mirrors
 * `json.dumps(obj, sort_keys=True, ensure_ascii=False)`.
 */
function sortedJsonStringify(value) {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    return JSON.stringify(value);
  }
  if (typeof value === "string") {
    // JSON.stringify quotes correctly and leaves non-ASCII raw, which
    // matches Python ensure_ascii=False.
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    const parts = value.map(sortedJsonStringify);
    return "[" + parts.join(", ") + "]";
  }
  if (typeof value === "object") {
    const keys = Object.keys(value).sort();
    const parts = keys.map(
      (k) => JSON.stringify(k) + ": " + sortedJsonStringify(value[k]),
    );
    return "{" + parts.join(", ") + "}";
  }
  throw new TypeError(`Unsupported value type in canonicalBytes: ${typeof value}`);
}

/**
 * Return canonical bytes for a receipt.
 *
 * @param {object} receipt - parsed scraper-mcp.act_receipt.v1 object
 * @returns {Buffer} UTF-8 encoded canonical JSON bytes
 */
export function canonicalBytes(receipt) {
  const cleaned = stripForCanonical(receipt);
  const json = sortedJsonStringify(cleaned);
  return Buffer.from(json, "utf-8");
}

/**
 * Return SHA-256 hex of canonicalBytes(receipt) — the cache key.
 *
 * @param {object} receipt
 * @returns {string} 64-char lowercase hex
 */
export function canonicalSha256(receipt) {
  return createHash("sha256").update(canonicalBytes(receipt)).digest("hex");
}

/**
 * Return the fraction of receipts matching the modal canonical hash.
 * 1.0 means all receipts produce byte-identical canonical form. null on
 * empty input.
 *
 * @param {object[]} receipts
 * @returns {number|null}
 */
export function cacheFriendlyScore(receipts) {
  if (!Array.isArray(receipts) || receipts.length === 0) return null;
  if (receipts.length === 1) return 1.0;
  const hashes = receipts.map(canonicalSha256);
  const counts = new Map();
  for (const h of hashes) counts.set(h, (counts.get(h) ?? 0) + 1);
  const top = Math.max(...counts.values());
  return top / hashes.length;
}
