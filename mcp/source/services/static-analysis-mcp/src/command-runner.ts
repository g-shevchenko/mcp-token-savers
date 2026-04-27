import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { StaticAnalysisConfig } from "./config.js";
import { clampText, redactSecrets } from "./text-utils.js";

export interface CommandResult {
  command: string[];
  cwd: string;
  duration_ms: number;
  exit_code: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
  stdout: string;
  timed_out: boolean;
}

export async function resolveRoot(config: StaticAnalysisConfig, rawRoot?: string): Promise<string> {
  const root = path.resolve(rawRoot || config.defaultRoot);
  const stat = await fs.stat(root);
  if (!stat.isDirectory()) {
    throw new Error(`root_path is not a directory: ${root}`);
  }
  return root;
}

export async function readPackageJson(root: string): Promise<Record<string, any> | null> {
  try {
    return JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));
  } catch {
    return null;
  }
}

export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.stat(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function commandExists(command: string, cwd: string): Promise<boolean> {
  const result = await runCommand([command, "--version"], cwd, 5000, 4000);
  return result.exit_code === 0;
}

export async function runCommand(
  command: string[],
  cwd: string,
  timeoutMs: number,
  maxCaptureChars: number,
): Promise<CommandResult> {
  const started = Date.now();
  if (command.length === 0 || !command[0]) {
    throw new Error("command must not be empty");
  }

  return new Promise((resolve) => {
    const child = spawn(command[0], command.slice(1), {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout = clampText(stdout + chunk.toString(), maxCaptureChars);
    });
    child.stderr.on("data", (chunk) => {
      stderr = clampText(stderr + chunk.toString(), maxCaptureChars);
    });
    child.on("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      resolve({
        command,
        cwd,
        duration_ms: Date.now() - started,
        exit_code: error.code === "ENOENT" ? 127 : null,
        signal: null,
        stderr: redactSecrets(error.message),
        stdout: "",
        timed_out: false,
      });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({
        command,
        cwd,
        duration_ms: Date.now() - started,
        exit_code: code,
        signal,
        stderr: redactSecrets(stderr),
        stdout: redactSecrets(stdout),
        timed_out: timedOut,
      });
    });
  });
}
