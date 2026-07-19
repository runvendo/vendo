/** ENG-225 — one clipboard write for every copy affordance (turn copy, code
    copy). `navigator.clipboard` needs a secure context; the execCommand path
    keeps copy alive on plain-http dev hosts. Resolves to whether the text made
    it out so callers only show "Copied" when it's true. */
import { useEffect, useRef, useState } from "react";

export async function writeClipboard(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== "undefined" && navigator.clipboard !== undefined) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Permission or focus refusal — try the legacy path below.
  }
  try {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    const copied = document.execCommand("copy");
    area.remove();
    return copied;
  } catch {
    return false;
  }
}

/** Transient copied feedback: flips true after a successful write, settles back
    after `holdMs`. The timer is owned here so unmount never leaks it. */
export function useCopyFeedback(holdMs = 1600): [boolean, (text: string) => void] {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = (text: string) => {
    void writeClipboard(text).then(ok => {
      if (!ok) return;
      setCopied(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), holdMs);
    });
  };
  return [copied, copy];
}
