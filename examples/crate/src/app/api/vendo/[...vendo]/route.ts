import { memoryKnowledgeAdapter } from "@vendoai/core/conformance";
import { clerk } from "@vendoai/vendo/auth/clerk";
import { createVendo, guard, nextVendoHandler } from "@vendoai/vendo/server";
import { clerkEnabled } from "@/server/clerk-config";
import { primaryStaff, staffFacts, staffForSubject } from "@/server/staff";
import { crateKnowledgeDocs } from "@/vendo/knowledge";
import { crateRegistry } from "@/vendo/registry";

// One preset fills all three identity seams: the request→principal resolver,
// the away/MCP actAs seam, and the door's OAuth adapter. Clerk answers "who
// signed in"; the seams below answer "and what does Crate know about them?".
// Crate's roster is the authority, and Vendo stores none of it.
const crateAuth = clerk({
  // Clerk's subject means nothing to Crate, so the join is on the email claim —
  // the one thing both sides already agree on. Returning null means "signed in,
  // but not staff here": the principal resolves to anonymous and away/MCP
  // minting for that subject declines. That is a real state, not an error.
  user: async (subject) => {
    const user = await staffForSubject(subject);
    if (!user) return null;
    return {
      display: user.display,
      email: user.email,
      // The [User] block: what the agent may know about whoever is signed in,
      // asserted fresh every request. Data, never instructions.
      facts: staffFacts(user),
    };
  },
  // Crate's own roster answers "which orgs?" — one shop, so being staff is the
  // whole question. Keyed on the principal rather than the request, so an
  // unattended run resolves the same answer an attended click does.
  memberships: async (principal) => {
    const user = await staffForSubject(principal.subject);
    if (!user) return [];
    return [{
      org: "crate",
      display: "Crate",
      teams: ["support"],
      admin: user.role === "admin",
    }];
  },
});

const vendo = createVendo({
  // ⚠️ The Clerk preset is composed only when Clerk is actually configured.
  // `clerk()` THROWS on any request carrying an `Authorization: Bearer …`
  // header when CLERK_SECRET_KEY is unset, and the throw surfaces as a 501
  // "Internal Vendo error" for the whole wire — which is the state
  // `vendo init --auth clerk` leaves you in before you have pasted your keys.
  // Unverifiable tokens return null two lines below it in the same preset; a
  // missing key ought to do the same. Until it does, this is the host's half
  // of the workaround. See ENG-415.
  //
  // The keyless branch is NOT "no identity" — Vendo no longer mints anonymous
  // sessions, so a composition without one refuses to build at all. Crate says
  // out loud what it was previously getting by default: with Clerk off, every
  // caller is the seeded shop owner. That is the same actor `resolveActor()`
  // returns for a keyless HTTP request, so the agent and the screens agree on
  // who is asking instead of disagreeing silently.
  ...(clerkEnabled
    ? { auth: crateAuth }
    : {
        principal: async () => ({
          kind: "user" as const,
          subject: primaryStaff().subject,
          display: primaryStaff().display,
        }),
      }),
  // Crate's own components, so a generated answer renders as an order card or a
  // line-item table rather than generic chrome. This half of the registry is
  // the BRIEFING — the model reads each description, prop schema and example to
  // decide what to render and what to bind. `<VendoProvider components>` in
  // layout.tsx reads the same object for the component references.
  catalog: crateRegistry,
  // .vendo/policy.json: destructive asks, reads run. The grades themselves are
  // authored in .vendo/overrides.json — refunds and cancellations are
  // destructive, and the demo reset never reaches the agent at all.
  guard: guard({ policy: {} }),
  // Store policy the agent answers from rather than invents: the return window,
  // shipping cutoffs, what the warranty covers. Left unset on Cloud, which
  // brings its own knowledge engine — this local corpus is the BYO path.
  ...(process.env.VENDO_API_KEY
    ? {}
    : { knowledge: memoryKnowledgeAdapter({ docs: crateKnowledgeDocs }) }),
});

export const { GET, POST, PUT, PATCH, DELETE } = nextVendoHandler(vendo);
