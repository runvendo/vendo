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
  return (
    <div data-pane="thesys-c1">
      {result.status === "ok" ? (
        <ThemeProvider>
          <C1Component
            c1Response={(result.raw as ThesysC1Raw | undefined)?.c1Response ?? ""}
            isStreaming={false}
          />
        </ThemeProvider>
      ) : (
        <PaneNonOk result={result} />
      )}
      <PaneFootnote>{FOOTNOTE}</PaneFootnote>
    </div>
  );
}
