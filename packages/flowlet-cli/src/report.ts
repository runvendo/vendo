import type { FrameworkInfo } from "./detect.js";
import type { ThemeSummary } from "./theme/extract-theme.js";
import type { ToolsSummary } from "./tools/extract-tools.js";
import type { ComponentsSummary } from "./components/extract-components.js";

export interface InitReport {
  info: FrameworkInfo;
  theme: ThemeSummary | null;
  tools: ToolsSummary | null;
  components: ComponentsSummary | null;
  llmSkipped: boolean;
}

export function renderReport(r: InitReport): string {
  const lines: string[] = [];
  lines.push(`framework: ${r.info.framework}   tailwind: ${r.info.tailwind}   openapi: ${r.info.openapiPath ?? "none"}`);
  if (r.theme) {
    lines.push(`theme.json: ${r.theme.written ? "written" : "SKIPPED"} (${r.theme.varCount} vars scanned)`);
    for (const [slot, v] of Object.entries(r.theme.matched)) lines.push(`  ${slot} <- ${v}`);
    if (r.theme.defaulted.length > 0) lines.push(`  DEFAULTED (edit by hand): ${r.theme.defaulted.join(", ")}`);
    if (r.theme.hasDarkVariant) lines.push("  note: dark-scoped vars exist; BrandTokens holds one mode — see .flowlet/README.md");
    for (const e of r.theme.errors) lines.push(`  warning: ${e}`);
  }
  if (r.tools) {
    lines.push(`tools.json: ${r.tools.toolCount} tools (source: ${r.tools.source})`);
    for (const e of r.tools.errors) lines.push(`  warning: ${e}`);
  }
  if (r.components) {
    lines.push(`components/: ${r.components.written.length}/${r.components.candidates} candidates wrapped`);
    for (const x of r.components.excluded) lines.push(`  excluded ${x.file}: ${x.reason}`);
    for (const f of r.components.failed) lines.push(`  FAILED ${f.file}: ${f.error}`);
  }
  if (r.llmSkipped) lines.push("LLM steps skipped (no ANTHROPIC_API_KEY or --skip-llm): route-scan fallback, component discovery");
  lines.push("All output is in .flowlet/ — review and edit it; nothing else in your repo was touched.");
  return lines.join("\n");
}
