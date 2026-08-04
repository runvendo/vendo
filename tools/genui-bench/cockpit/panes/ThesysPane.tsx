"use client";
/**
 * Thesys C1 pane — renders the lane's C1 DSL response with THEIR renderer and
 * theme (honest, not re-skinned), per the spec's competitor-pane rule.
 */
import "@crayonai/react-ui/styles/index.css";
import { C1Component, ThemeProvider } from "@thesysai/genui-sdk";
import type { ThesysC1Raw } from "../../lanes/thesys-c1";
import type { PaneProps } from "../pane-props";
import { PaneFootnote, PaneNonOk } from "./pane-chrome";

const FOOTNOTE = "Thesys C1 — their renderer/theme · same prompt + tools";

export default function ThesysPane({ result }: PaneProps) {
  const raw = result.status === "ok" ? (result.raw as ThesysC1Raw | undefined) : undefined;
  return (
    <div data-pane="thesys-c1">
      {result.status === "ok" ? (
        <ThemeProvider>
          {/* c1Response is C1's full `<content …>` envelope; their component
              parses it (v1 JSON DSL / v2 openui-lang) — do not unwrap it. */}
          <C1Component c1Response={raw?.c1Response ?? ""} isStreaming={false} />
        </ThemeProvider>
      ) : (
        <PaneNonOk result={result} />
      )}
      <PaneFootnote>
        {FOOTNOTE}
        {raw?.model ? ` · ${raw.model}` : ""}
        {" · C1 is model-agnostic (their catalog also carries GPT-5.2 and Gemini 3)"}
      </PaneFootnote>
    </div>
  );
}
