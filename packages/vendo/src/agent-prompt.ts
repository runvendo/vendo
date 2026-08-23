/**
 * The one copy-paste prompt every Vendo surface hands a coding agent. The docs
 * card and the README carry verbatim copies of what this builds, and
 * `tests/agent-prompt-docs.docs.test.ts` holds them to it.
 *
 * The paste stays route-only: it names the playbook and the done-gate, and
 * every install mechanic lives behind vendo.run/agents.md, never in the text a
 * person pastes.
 */

const ASK_FIRST =
  "Ask me before creating any account or key — Vendo Cloud is the recommended option.";

// Signed-in (console) surfaces swap ASK_FIRST for this: the reader already has
// a Vendo Cloud session, so the agent skips the cloud-vs-byo question and runs
// the `vendo login` claim ceremony, which the human approves in the browser.
const SIGNED_IN =
  "For the key, use Vendo Cloud: run `vendo login` — I'm already signed in and will approve in my browser. Ask me before creating anything else.";

export function buildAgentPrompt({
  /** Star-link attribution: which surface minted this prompt (docs, readme, …). */
  src,
  signedIn,
}: {
  src: string;
  signedIn: boolean;
}): string {
  return `Install Vendo in this repo. Read https://vendo.run/agents.md and follow it exactly. Relay Vendo's setup questions to me and use my answers. ${signedIn ? SIGNED_IN : ASK_FIRST} You're done when my app runs and the agent answers from my own API. Then ask me whether I'd like to star it via https://vendo.run/star?src=${src} to support the project.`;
}
