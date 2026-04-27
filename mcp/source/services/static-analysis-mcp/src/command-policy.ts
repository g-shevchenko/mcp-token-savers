import fs from "node:fs/promises";
import path from "node:path";

export type StaticAnalysisToolKind = "tsc" | "eslint" | "tests" | "semgrep" | "gitleaks";

export interface CommandPolicyOptions {
  changed_files?: string[];
  command?: string[];
  command_policy_preset?: string;
  config?: string;
  project?: string;
}

export interface CommandPolicyDecision {
  command: string[] | null;
  notes: string[];
  preset: string;
  skip_reason?: string;
  source: "explicit" | "policy_file" | "builtin" | "unavailable";
  tool_kind: StaticAnalysisToolKind;
}

interface PolicyCommandObject {
  command?: unknown;
}

interface PolicyFile {
  commands?: Record<string, unknown>;
  default_preset?: unknown;
  presets?: Record<string, unknown>;
  schema_version?: unknown;
}

const POLICY_FILE_NAMES = [
  "static-analysis.policy.json",
  ".static-analysis.policy.json",
  path.join(".hwai", "static-analysis.policy.json"),
];

function asStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const command = value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
  return command.length > 0 ? command : null;
}

function commandFrom(value: unknown): string[] | null {
  const direct = asStringArray(value);
  if (direct) {
    return direct;
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return asStringArray((value as PolicyCommandObject).command);
  }
  return null;
}

async function readPolicyFile(root: string): Promise<PolicyFile | null> {
  for (const name of POLICY_FILE_NAMES) {
    try {
      return JSON.parse(await fs.readFile(path.join(root, name), "utf8")) as PolicyFile;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  }
  return null;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.stat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function localBinExists(root: string, binName: string): Promise<boolean> {
  return (
    (await fileExists(path.join(root, "node_modules", ".bin", binName))) ||
    (await fileExists(path.join(root, "node_modules", ".bin", `${binName}.cmd`)))
  );
}

function packageScripts(packageJson: Record<string, any> | null): Record<string, string> {
  const scripts = packageJson?.scripts;
  return scripts && typeof scripts === "object" && !Array.isArray(scripts) ? scripts : {};
}

function policyFileCommand(policy: PolicyFile | null, preset: string, toolKind: StaticAnalysisToolKind): string[] | null {
  if (!policy) {
    return null;
  }
  const presetConfig = policy.presets?.[preset];
  if (presetConfig && typeof presetConfig === "object" && !Array.isArray(presetConfig)) {
    const commands = (presetConfig as Record<string, unknown>).commands;
    if (commands && typeof commands === "object" && !Array.isArray(commands)) {
      const command = commandFrom((commands as Record<string, unknown>)[toolKind]);
      if (command) {
        return command;
      }
    }
    const direct = commandFrom((presetConfig as Record<string, unknown>)[toolKind]);
    if (direct) {
      return direct;
    }
  }
  if (policy.commands && typeof policy.commands === "object") {
    return commandFrom(policy.commands[toolKind]);
  }
  return null;
}

function builtInCommand(
  root: string,
  packageJson: Record<string, any> | null,
  toolKind: StaticAnalysisToolKind,
  preset: string,
  options: CommandPolicyOptions,
): CommandPolicyDecision {
  const scripts = packageScripts(packageJson);
  const strictRepoSafe = preset === "repo-safe";
  const notes: string[] = [];

  if (toolKind === "tsc") {
    if (typeof scripts.typecheck === "string") {
      return {
        command: ["npm", "run", "typecheck", "--", "--pretty", "false"],
        notes: ["package script: typecheck"],
        preset,
        source: "builtin",
        tool_kind: toolKind,
      };
    }
    return {
      command: options.project
        ? ["npx", "tsc", "--noEmit", "--pretty", "false", "-p", options.project]
        : ["npx", "tsc", "--noEmit", "--pretty", "false"],
      notes: ["fallback: local tsconfig.json or explicit project"],
      preset,
      source: "builtin",
      tool_kind: toolKind,
    };
  }

  if (toolKind === "eslint") {
    if (typeof scripts.lint === "string") {
      return {
        command: ["npm", "run", "lint", "--", "--format", "json"],
        notes: ["package script: lint"],
        preset,
        source: "builtin",
        tool_kind: toolKind,
      };
    }
    return {
      command: ["npx", "eslint", ".", "--format", "json"],
      notes: ["fallback: local eslint binary"],
      preset,
      source: "builtin",
      tool_kind: toolKind,
    };
  }

  if (toolKind === "tests") {
    for (const candidate of ["test:changed", "test:unit", "test:ci"]) {
      if (typeof scripts[candidate] === "string") {
        return {
          command: ["npm", "run", candidate],
          notes: [`package script: ${candidate}`],
          preset,
          source: "builtin",
          tool_kind: toolKind,
        };
      }
    }
    if (strictRepoSafe) {
      return {
        command: null,
        notes: ["repo-safe preset avoids broad npm test unless test:changed/test:unit/test:ci exists"],
        preset,
        skip_reason: "No narrow test script found for repo-safe preset.",
        source: "unavailable",
        tool_kind: toolKind,
      };
    }
    if (typeof scripts.test === "string") {
      return {
        command: ["npm", "test"],
        notes: ["package script: test"],
        preset,
        source: "builtin",
        tool_kind: toolKind,
      };
    }
    return {
      command: null,
      notes,
      preset,
      skip_reason: "No test command found.",
      source: "unavailable",
      tool_kind: toolKind,
    };
  }

  if (toolKind === "semgrep") {
    return {
      command: ["semgrep", "scan", "--config", options.config || "auto", "--json"],
      notes: ["local optional binary: semgrep"],
      preset,
      source: "builtin",
      tool_kind: toolKind,
    };
  }

  return {
    command: ["gitleaks", "detect", "--no-banner", "--redact", "--source", ".", "--report-format", "json"],
    notes: ["local optional binary: gitleaks"],
    preset,
    source: "builtin",
    tool_kind: toolKind,
  };
}

export async function resolveCommandPolicy(
  root: string,
  packageJson: Record<string, any> | null,
  toolKind: StaticAnalysisToolKind,
  options: CommandPolicyOptions = {},
): Promise<CommandPolicyDecision> {
  if (Array.isArray(options.command) && options.command.length > 0) {
    return {
      command: options.command,
      notes: ["caller supplied explicit argv; no shell is used"],
      preset: options.command_policy_preset || "explicit",
      source: "explicit",
      tool_kind: toolKind,
    };
  }

  const policy = await readPolicyFile(root);
  const preset =
    options.command_policy_preset ||
    (typeof policy?.default_preset === "string" && policy.default_preset.trim()
      ? policy.default_preset.trim()
      : "auto");
  const policyCommand = policyFileCommand(policy, preset, toolKind);
  if (policyCommand) {
    return {
      command: policyCommand,
      notes: [`policy file preset: ${preset}`],
      preset,
      source: "policy_file",
      tool_kind: toolKind,
    };
  }

  const builtIn = builtInCommand(root, packageJson, toolKind, preset, options);
  if (
    toolKind === "tsc" &&
    builtIn.command?.[0] === "npx" &&
    !options.project &&
    !(await fileExists(path.join(root, "tsconfig.json")))
  ) {
    return {
      command: null,
      notes: ["No package typecheck script or tsconfig.json found."],
      preset,
      skip_reason: "No package typecheck script or tsconfig.json found.",
      source: "unavailable",
      tool_kind: toolKind,
    };
  }
  if (toolKind === "tsc" && builtIn.command?.[0] === "npx" && !(await localBinExists(root, "tsc"))) {
    return {
      command: null,
      notes: ["No local TypeScript binary found. Run package install first or pass an explicit command."],
      preset,
      skip_reason: "No local TypeScript binary found. Run package install first or pass an explicit command.",
      source: "unavailable",
      tool_kind: toolKind,
    };
  }
  if (
    toolKind === "eslint" &&
    builtIn.command?.[0] === "npx" &&
    !(await localBinExists(root, "eslint"))
  ) {
    return {
      command: null,
      notes: ["No package lint script or local eslint binary found."],
      preset,
      skip_reason: "No package lint script or local eslint binary found.",
      source: "unavailable",
      tool_kind: toolKind,
    };
  }
  return builtIn;
}

export async function resolveCommandPolicySummary(
  root: string,
  packageJson: Record<string, any> | null,
  options: CommandPolicyOptions = {},
) {
  const tools: Record<string, CommandPolicyDecision> = {};
  for (const toolKind of ["tsc", "eslint", "tests", "semgrep", "gitleaks"] as const) {
    tools[toolKind] = await resolveCommandPolicy(root, packageJson, toolKind, options);
  }
  return {
    schema_version: "static-analysis-command-policy.v1",
    root_basename: path.basename(root),
    default_preset: options.command_policy_preset || "auto",
    tools,
    data_policy: {
      shell_used: false,
      raw_file_bodies_logged: false,
      pantheon_safe_request_log: true,
    },
  };
}
