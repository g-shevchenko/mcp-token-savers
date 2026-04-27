import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { redactSecrets } from "./text-utils.js";

interface CommandResult {
  code: number | null;
  stderr: Buffer;
  stdout: Buffer;
}

function run(command: string, args: string[], timeoutMs = 15_000): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`${command} timed out`));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) });
    });
  });
}

export async function listZipEntries(zipPath: string): Promise<string[]> {
  await fs.access(zipPath);
  const result = await run("unzip", ["-Z1", zipPath]);
  if (result.code !== 0) {
    throw new Error(redactSecrets(`unzip list failed: ${result.stderr.toString("utf8").trim()}`));
  }
  return result.stdout
    .toString("utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

export async function readZipEntry(zipPath: string, entry: string, maxBytes: number): Promise<Buffer> {
  await fs.access(zipPath);
  const normalized = entry.replace(/^\/+/, "");
  if (normalized.includes("..")) {
    throw new Error("zip entry path traversal is not allowed");
  }
  const result = await run("unzip", ["-p", zipPath, normalized]);
  if (result.code !== 0) {
    throw new Error(redactSecrets(`unzip read failed: ${result.stderr.toString("utf8").trim()}`));
  }
  return result.stdout.length > maxBytes ? result.stdout.subarray(0, maxBytes) : result.stdout;
}

export function isScreenshotEntry(entry: string): boolean {
  return /\.(png|jpe?g|webp)$/i.test(path.basename(entry));
}

export function isTraceEntry(entry: string): boolean {
  return /\.(trace|trace\.json|jsonl)$/i.test(entry) || /(^|\/)trace\.(trace|jsonl)$/i.test(entry);
}

export function isNetworkEntry(entry: string): boolean {
  return /\.(network|har)$/i.test(entry) || /(^|\/)trace\.network$/i.test(entry);
}
