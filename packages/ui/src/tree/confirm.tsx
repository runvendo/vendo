/**
 * The confirmation a mutating action gets BY CONSTRUCTION.
 *
 * Nobody has to remember a dialog: the compiler stamps every action bound to a
 * tool the host graded above `read` (`Tree.confirmActions`), and the renderer's
 * one dispatch stands this in front of the call (renderer.tsx `runAction`). One
 * implementation for every venue — a wire document's Button, a host-mounted
 * island, a jailed one — because all three fire through that dispatch.
 *
 * Two rules keep it from being a click-through: the SAFE answer comes first in
 * the DOM (and is what Escape and the backdrop choose), the mutating one last.
 *
 * It is built out of the Kit, not out of its own CSS, so it is brand-native for
 * the same reason every other surface is: the host's theme tokens.
 */
import type { Json } from "@vendoai/core";
import { useEffect, type CSSProperties } from "react";
import { Card, Row } from "../kit/layout.js";
import { Button } from "../kit/forms/button.js";
import { t } from "../kit/tokens.js";

/** The action awaiting an answer, and its bound arguments. */
export interface ConfirmRequest {
  action: string;
  payload?: Json;
}

/** `cancel_transfer` → `Cancel transfer`: the host's own verb, in words a person
 *  reads. The tool name is all the runtime honestly knows about the act. */
export const actionPhrase = (action: string): string => {
  const words = action.replace(/[_-]+/g, " ").trim();
  return words === "" ? action : `${words[0]!.toUpperCase()}${words.slice(1)}`;
};

/** What is about to be sent, from the arguments the control bound — `Id: tr_1`.
 *  Scalars only: an object or an array is structure, not something to read. */
const argumentLine = (payload: Json | undefined): string => {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return "";
  return Object.entries(payload)
    .filter(([, value]) => value !== null && typeof value !== "object" && String(value) !== "")
    .map(([key, value]) => `${actionPhrase(key)}: ${String(value)}`)
    .join(" · ");
};

const backdrop: CSSProperties = {
  position: "fixed",
  inset: 0,
  zIndex: 2147483000,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: "24px",
  background: `color-mix(in srgb, ${t.text} 38%, transparent)`,
};

export function ActionConfirm({
  request,
  onAnswer,
}: {
  request: ConfirmRequest;
  onAnswer: (confirmed: boolean) => void;
}) {
  // Escape declines. A confirmation nobody can back out of with the keyboard is
  // a trap, and the answer it forces is the destructive one.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") onAnswer(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onAnswer]);

  const phrase = actionPhrase(request.action);
  const argument = argumentLine(request.payload);
  const heading = `${phrase}?`;
  return (
    <div data-vendo-confirm={request.action} style={backdrop} onClick={() => onAnswer(false)}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={heading}
        style={{ width: "min(420px, 100%)" }}
        onClick={(event) => event.stopPropagation()}
      >
        <Card
          title={heading}
          description={argument === ""
            ? "Nothing is sent until you confirm."
            : `${argument} — nothing is sent until you confirm.`}
        >
          <Row gap={8} justify="end">
            <Button label="Keep it" variant="secondary" onClick={() => onAnswer(false)} />
            <Button label={`Yes, ${phrase.toLowerCase()}`} variant="danger" onClick={() => onAnswer(true)} />
          </Row>
        </Card>
      </div>
    </div>
  );
}
