import fs from "node:fs";
import path from "node:path";

const COMMON_RG_PATHS = [
  "/Applications/Codex.app/Contents/Resources/rg",
  "/opt/homebrew/bin/rg",
  "/usr/local/bin/rg",
  "/usr/bin/rg",
];

function isExecutable(filePath: string): boolean {
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function resolveLocalCommand(command: string, cwd?: string): string {
  if (command !== "rg") {
    return command;
  }

  const configuredPath = process.env.RETRIEVAL_RG_PATH?.trim();
  const localNodePath = cwd ? path.join(cwd, "node_modules", ".bin", "rg") : "";
  for (const candidate of [configuredPath, ...COMMON_RG_PATHS, localNodePath]) {
    if (candidate && isExecutable(candidate)) {
      return candidate;
    }
  }

  return command;
}

export function isMissingCommandError(error: any, command: string): boolean {
  const message = error instanceof Error ? error.message : String(error || "");
  return error?.code === "ENOENT" && (
    error?.path === command ||
    message.includes(`spawn ${command} ENOENT`) ||
    (command === "rg" && message.includes("spawn") && message.includes("ENOENT"))
  );
}

export function commandUnavailableWarning(command: string): string {
  if (command === "rg") {
    return "rg executable not found; set RETRIEVAL_RG_PATH or install ripgrep for full retrieval recall";
  }
  return `${command} executable not found`;
}
