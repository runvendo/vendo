/**
 * The clone's registered host components (ENG-184 3-file path, step 1:
 * descriptors). React-free on purpose — this module feeds the server (agent
 * prompt + registry validation) AND the client provider; the React adapters
 * live in vendo-sandbox/impls.jsx and compile into the sandbox bundle only.
 *
 * Plain JS so both the CRA frontend and the tsx-run server can import it.
 */
import { z } from "zod";
import { hostComponent, toHostRegistry } from "@vendoai/components/descriptors";

export const emailRowDescriptor = hostComponent(
  "GmailEmailRow",
  "The app's own inbox row: sender, subject, snippet and date in the exact list style " +
    "the mail app renders. Use it whenever you show an email as a line item (lists of " +
    "matching mail, search results, digests). `unread` bolds it like the real inbox; " +
    "`starred` fills the star.",
  z.object({
    sender: z.string().describe("Sender display name."),
    subject: z.string().describe("Subject line."),
    snippet: z.string().optional().describe("Body preview after the subject."),
    date: z.string().optional().describe("Short date label, e.g. '10:42 AM' or 'Jul 1'."),
    unread: z.boolean().optional().describe("Bold the row like unread mail."),
    starred: z.boolean().optional().describe("Show a filled star."),
  }),
);

export const composeChipDescriptor = hostComponent(
  "GmailComposeChip",
  "The app's own Compose pill button (the multicolor plus + label). Use it as the " +
    "call-to-action when a view invites writing an email. Purely visual — pair it with " +
    "a dispatch in your component if it should act.",
  z.object({
    label: z.string().optional().describe("Button label (default 'Compose')."),
  }),
);

export const gmailHostDescriptors = [emailRowDescriptor, composeChipDescriptor];

/** F1 registry entries (source:"host") for the provider + genui validation. */
export const gmailHostComponents = toHostRegistry(gmailHostDescriptors);
