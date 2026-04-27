#!/usr/bin/env python3
import json
import os
import sys
import time
import urllib.request

BASE_URL = os.environ.get("CONTEXT_PREP_URL", "http://127.0.0.1:3394").rstrip("/")
MCP_URL = os.environ.get("CONTEXT_PREP_MCP_URL", f"{BASE_URL}/mcp")


def call_tool(name, arguments):
    payload = json.dumps(
        {
            "jsonrpc": "2.0",
            "id": int(time.time() * 1000),
            "method": "tools/call",
            "params": {"name": name, "arguments": arguments},
        }
    ).encode("utf-8")
    req = urllib.request.Request(
        MCP_URL,
        data=payload,
        headers={
            "content-type": "application/json",
            "accept": "application/json, text/event-stream",
        },
        method="POST",
    )
    started = time.time()
    with urllib.request.urlopen(req, timeout=30) as res:
        body = res.read().decode("utf-8")
    elapsed_ms = int((time.time() - started) * 1000)
    rpc = parse_mcp_response(body)
    text = rpc["result"]["content"][0]["text"]
    return json.loads(text), elapsed_ms


def parse_mcp_response(body):
    stripped = body.strip()
    if stripped.startswith("event:"):
        data_lines = []
        for line in stripped.splitlines():
            if line.startswith("data:"):
                data_lines.append(line.removeprefix("data:").strip())
        if not data_lines:
            raise ValueError("missing data line in event-stream MCP response")
        return json.loads("\n".join(data_lines))
    return json.loads(stripped)


def assert_true(condition, message):
    if not condition:
        raise AssertionError(message)


def bench_logs():
    log = "\n".join(
        ["info: compiling package module=payments step=typescript cache=warm elapsed_ms=17"] * 500
        + [
            "$ npm run build",
            "src/server.ts:42:11 - error TS2304: Cannot find name 'contextPrep'.",
            "Build failed with 1 error",
        ]
        + ["info: cleanup artifact=dist status=skipped reason=build_failed"] * 500
    )
    result, elapsed = call_tool(
        "prep_logs",
        {
            "text": log,
            "context": "benchmark build failure",
            "metadata": {"source": "benchmark-http"},
        },
    )
    assert_true(result["prep_mode"] == "logs-prep", "wrong prep mode")
    assert_true("TS2304" in result["likely_root_cause"], "missing first real error")
    assert_true("src/server.ts" in result["impacted_files"], "missing impacted file")
    assert_true(result["input_stats"]["savings_pct"] >= 50, "expected token savings")
    return elapsed


def bench_text():
    text = """
    Решение: запускаем context-prep-mcp parser-first, без LLM в v1.
    Нужно добавить prep_logs, prep_url, prep_text и artifact fallback.
    Open question: когда подключать ContentOS?
    Risk: exact wording can be lost if compression is too aggressive.
    """ * 30
    result, elapsed = call_tool(
        "prep_text",
        {
            "text": text,
            "purpose": "benchmark handoff",
            "metadata": {"source": "benchmark-http"},
        },
    )
    assert_true(result["prep_mode"] == "text-prep", "wrong prep mode")
    assert_true(result["extracted"]["decisions"], "missing decisions")
    assert_true(result["extracted"]["action_items"], "missing action items")
    assert_true(result["extracted"]["open_questions"], "missing open questions")
    return elapsed


def bench_url():
    result, elapsed = call_tool(
        "prep_url",
        {
            "url": "https://example.com",
            "purpose": "benchmark URL prep",
            "parser_stack": "local",
            "metadata": {"source": "benchmark-http"},
        },
    )
    assert_true(result["prep_mode"] == "url-prep", "wrong prep mode")
    assert_true(result["title"], "missing title")
    assert_true(result["final_url"].startswith("https://example.com"), "wrong final url")
    assert_true(result["parser_stack"]["used"] == "local", "expected local parser path")
    return elapsed


def bench_url_scraper_core():
    if not os.environ.get("CONTEXT_PREP_EXPECT_SCRAPER_CORE"):
        return None

    result, elapsed = call_tool(
        "prep_url",
        {
            "url": "https://example.com",
            "purpose": "benchmark forced scraper-core URL prep",
            "parser_stack": "scraper_core",
            "max_tier": "curl_cffi",
            "metadata": {"source": "benchmark-http"},
        },
    )
    assert_true(result["prep_mode"] == "url-prep", "wrong prep mode")
    assert_true(result["parser_stack"]["used"] == "scraper_core", "expected scraper-core parser path")
    assert_true(result["parser_stack"].get("scraper_core", {}).get("engine"), "missing scraper-core engine")
    return elapsed


def main():
    checks = [("logs", bench_logs), ("text", bench_text), ("url", bench_url), ("url_scraper_core", bench_url_scraper_core)]
    failures = []
    timings = {}

    for name, fn in checks:
        try:
            elapsed = fn()
            if elapsed is None:
                print(f"SKIP {name}: set CONTEXT_PREP_EXPECT_SCRAPER_CORE=1 to require this check")
                continue
            timings[name] = elapsed
            print(f"PASS {name}: {timings[name]}ms")
        except Exception as exc:
            failures.append((name, str(exc)))
            print(f"FAIL {name}: {exc}")

    print(json.dumps({"base_url": BASE_URL, "mcp_url": MCP_URL, "timings_ms": timings, "failures": failures}, indent=2))
    if failures:
        sys.exit(1)


if __name__ == "__main__":
    main()
