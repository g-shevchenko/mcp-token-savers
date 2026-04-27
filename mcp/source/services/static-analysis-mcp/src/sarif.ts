import path from "node:path";
import { Finding } from "./analyzers.js";

function relativeFile(root: string, uri: string | undefined): string | undefined {
  if (!uri) {
    return undefined;
  }
  const clean = uri.replace(/^file:\/\//, "");
  if (!path.isAbsolute(clean)) {
    return clean.replace(/\\/g, "/");
  }
  return path.relative(root, clean).replace(/\\/g, "/");
}

function severityFromLevel(level: unknown): "error" | "warning" | "notice" {
  return level === "error" || level === "warning" || level === "notice" ? level : "warning";
}

export function summarizeSarifObject(sarif: any, root: string, maxFindings: number) {
  const findings: Finding[] = [];
  for (const run of Array.isArray(sarif?.runs) ? sarif.runs : []) {
    const toolName = String(run.tool?.driver?.name || "sarif");
    for (const result of Array.isArray(run.results) ? run.results : []) {
      const location = result.locations?.[0]?.physicalLocation;
      findings.push({
        file: relativeFile(root, location?.artifactLocation?.uri),
        line: typeof location?.region?.startLine === "number" ? location.region.startLine : undefined,
        column: typeof location?.region?.startColumn === "number" ? location.region.startColumn : undefined,
        message: String(result.message?.text || result.message?.markdown || "SARIF finding"),
        rule_id: typeof result.ruleId === "string" ? result.ruleId : undefined,
        severity: severityFromLevel(result.level),
        source: toolName,
      });
    }
  }
  const limited = findings.slice(0, maxFindings);
  return {
    findings: limited,
    finding_counts: {
      total: findings.length,
      errors: findings.filter((finding) => finding.severity === "error").length,
      warnings: findings.filter((finding) => finding.severity === "warning").length,
      notices: findings.filter((finding) => finding.severity === "notice").length,
      returned: limited.length,
    },
  };
}
