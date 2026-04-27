#!/usr/bin/env node
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";

function argValue(name, fallback = "") {
  const prefix = `${name}=`;
  const match = process.argv.find((arg) => arg.startsWith(prefix));
  return match ? match.slice(prefix.length) : fallback;
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address()));
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

const outDir = path.resolve(argValue("--out", path.join(os.tmpdir(), `playwright-trace-mcp-real-${Date.now()}`)));
await fs.mkdir(outDir, { recursive: true });

const html = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <title>HWAI Playwright Trace Fixture</title>
  </head>
  <body>
    <main>
      <h1>Trace fixture</h1>
      <button id="save">Save</button>
      <script>
        console.warn("fixture warning before action");
        document.querySelector("#save").addEventListener("click", async () => {
          console.error("Fixture save failed for trace benchmark");
          await Promise.allSettled([
            fetch("/api/save?debug=true", { method: "POST", body: "{}" }),
            fetch("/api/slow-report", { method: "GET" })
          ]);
        });
      </script>
    </main>
  </body>
</html>`;

const server = http.createServer((req, res) => {
  if (req.url?.startsWith("/api/save")) {
    res.writeHead(503, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: false, reason: "fixture failure" }));
    return;
  }
  if (req.url?.startsWith("/api/slow-report")) {
    setTimeout(() => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, slow: true }));
    }, 1100);
    return;
  }
  res.writeHead(200, { "content-type": "text/html" });
  res.end(html);
});

const address = await listen(server);
if (!address || typeof address === "string") {
  throw new Error("Unable to bind local fixture server");
}

const baseUrl = `http://127.0.0.1:${address.port}`;
const traceZipPath = path.join(outDir, "fixture-trace.zip");
const harPath = path.join(outDir, "fixture.har");
const screenshotPath = path.join(outDir, "fixture-screenshot.png");
let caughtFailure = "";

let browser;
let context;
try {
  browser = await chromium.launch({ headless: true });
  context = await browser.newContext({
    recordHar: {
      path: harPath,
      content: "omit",
    },
    viewport: { width: 900, height: 620 },
  });
  await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
  const page = await context.newPage();
  await page.goto(baseUrl);
  const saveResponse = page.waitForResponse((response) => response.url().includes("/api/save"));
  const slowResponse = page.waitForResponse((response) => response.url().includes("/api/slow-report"));
  await page.locator("#save").click();
  await Promise.allSettled([saveResponse, slowResponse]);
  try {
    await page.locator("#missing-after-save").click({ timeout: 500 });
  } catch (error) {
    caughtFailure = error instanceof Error ? error.message : String(error);
  }
  await page.screenshot({ path: screenshotPath, fullPage: true });
  await context.tracing.stop({ path: traceZipPath });
  await context.close();
  context = undefined;
  await browser.close();
  browser = undefined;
} catch (error) {
  process.stderr.write(`Unable to generate real Playwright fixtures: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 2;
} finally {
  if (context) {
    await context.close().catch(() => undefined);
  }
  if (browser) {
    await browser.close().catch(() => undefined);
  }
  await close(server);
}

if (process.exitCode) {
  process.exit(process.exitCode);
}

const manifest = {
  generated_at: new Date().toISOString(),
  generator: "playwright-trace-mcp-real-fixture.v1",
  trace_zip_path: traceZipPath,
  har_path: harPath,
  screenshot_path: screenshotPath,
  caught_failure_preview: caughtFailure.split("\n").slice(0, 2).join("\n"),
};
await fs.writeFile(path.join(outDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
