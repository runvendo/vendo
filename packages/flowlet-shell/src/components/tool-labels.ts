/** Humanize a tool slug: `set_rule` / `GMAIL_FETCH` / `renderDemoCard`
 *  -> `Set Rule` / `Gmail Fetch` / `Render Demo Card`. */
export function humanize(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2") // split camelCase before lowering
    .replace(/[_-]+/g, " ")
    .trim()
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Present-participle, past-tense, and imperative labels for a tool slug. */
export interface ToolAction {
  /** "Creating Gmail email draft" — shown while the call runs. */
  active: string;
  /** "Created Gmail email draft" — shown once it settles. */
  done: string;
  /** "Create Gmail email draft" — what the agent is asking permission to do. */
  request: string;
  /** "Create Gmail email draft?" — the approval card's plain yes/no title
   *  (spec Moment 3: "Send Acme a payment reminder?"). Derived from `request`
   *  by default; `EXACT`/Gmail/Slack overrides may hand-author a better one. */
  question: string;
}

/** "Create Gmail email draft" -> "Create Gmail email draft?" — never doubles
 *  a trailing "?" if a hand-authored request already ends with one. */
function toQuestion(request: string): string {
  return request.endsWith("?") ? request : `${request}?`;
}

const EXACT: Record<string, Omit<ToolAction, "question">> = {
  get_transactions: { active: "Reading transactions", done: "Read transactions", request: "Read transactions" },
  SLACK_API_TEST: { active: "Checking Slack", done: "Checked Slack", request: "Check Slack" },
  create_automation: { active: "Setting up automation", done: "Set up automation", request: "Create an automation" },
  update_automation: { active: "Updating automation", done: "Updated automation", request: "Update an automation" },
  delete_automation: { active: "Deleting automation", done: "Deleted automation", request: "Delete an automation" },
  list_automations: { active: "Listing automations", done: "Listed automations", request: "List automations" },
  get_automation_runs: { active: "Reading run history", done: "Read run history", request: "Read run history" },
  pause_automation: { active: "Pausing automation", done: "Paused automation", request: "Pause an automation" },
  resume_automation: { active: "Resuming automation", done: "Resumed automation", request: "Resume an automation" },
  run_automation_now: { active: "Test-firing automation", done: "Test-fired automation", request: "Test-fire an automation" },
};

/** Composio toolkit ids -> display names (mirrors the connect catalog). */
const TOOLKITS: Record<string, string> = {
  GMAIL: "Gmail",
  SLACK: "Slack",
  NOTION: "Notion",
  GITHUB: "GitHub",
  GOOGLECALENDAR: "Google Calendar",
  LINEAR: "Linear",
  GOOGLEDRIVE: "Google Drive",
  DISCORD: "Discord",
  GOOGLESHEETS: "Google Sheets",
  GOOGLEDOCS: "Google Docs",
  STRIPE: "Stripe",
  JIRA: "Jira",
  ASANA: "Asana",
  HUBSPOT: "HubSpot",
  AIRTABLE: "Airtable",
};

/** Verb segment -> [present participle, past tense, imperative]. Covers the
 *  verbs Composio uses across its catalogs plus common host-tool verbs. */
const VERBS: Record<string, [active: string, done: string, base: string]> = {
  SEND: ["Sending", "Sent", "Send"],
  CREATE: ["Creating", "Created", "Create"],
  UPDATE: ["Updating", "Updated", "Update"],
  DELETE: ["Deleting", "Deleted", "Delete"],
  REMOVE: ["Removing", "Removed", "Remove"],
  REPLACE: ["Replacing", "Replaced", "Replace"],
  ADD: ["Adding", "Added", "Add"],
  SET: ["Setting", "Set", "Set"],
  POST: ["Posting", "Posted", "Post"],
  WRITE: ["Writing", "Wrote", "Write"],
  FETCH: ["Fetching", "Fetched", "Fetch"],
  GET: ["Getting", "Got", "Get"],
  LIST: ["Listing", "Listed", "List"],
  SEARCH: ["Searching", "Searched", "Search"],
  FIND: ["Finding", "Found", "Find"],
  READ: ["Reading", "Read", "Read"],
  REPLY: ["Replying to", "Replied to", "Reply to"],
  MOVE: ["Moving", "Moved", "Move"],
  ARCHIVE: ["Archiving", "Archived", "Archive"],
  RENDER: ["Rendering", "Rendered", "Render"],
  RUN: ["Running", "Ran", "Run"],
  EXECUTE: ["Running", "Ran", "Run"],
  UPLOAD: ["Uploading", "Uploaded", "Upload"],
  DOWNLOAD: ["Downloading", "Downloaded", "Download"],
};

function fromVerb(verbKey: string, tail: string): ToolAction {
  const [active, done, base] = VERBS[verbKey]!;
  const request = tail ? `${base} ${tail}` : base;
  return {
    active: tail ? `${active} ${tail}` : active,
    done: tail ? `${done} ${tail}` : done,
    request,
    question: toQuestion(request),
  };
}

/** Compose "{Verb} {Toolkit} {object}" from an underscore-segmented slug whose
 *  first segment is a known toolkit. Returns null when no verb is found. */
function composioAction(toolName: string): ToolAction | null {
  const segments = toolName.split("_");
  const toolkit = TOOLKITS[segments[0]?.toUpperCase() ?? ""];
  if (!toolkit || segments.length < 2) return null;
  const rest = segments.slice(1);
  const verbIx = rest.findIndex((s) => VERBS[s.toUpperCase()]);
  if (verbIx === -1) return null;
  const object = rest
    .filter((_, i) => i !== verbIx)
    .join(" ")
    .toLowerCase();
  return fromVerb(rest[verbIx]!.toUpperCase(), object ? `${toolkit} ${object}` : toolkit);
}

/** Verb-aware labels for camelCase/snake host tools: `renderDemoCard` ->
 *  "Rendering demo card". Returns null when the first word isn't a verb. */
function hostAction(toolName: string): ToolAction | null {
  const words = humanize(toolName).split(" ");
  const verbKey = words[0]?.toUpperCase() ?? "";
  if (!VERBS[verbKey] || words.length < 2) return null;
  return fromVerb(verbKey, words.slice(1).join(" ").toLowerCase());
}

/**
 * Map a tool slug to friendly action labels. Precedence: exact overrides, the
 * hand-tuned Gmail/Slack phrasing, the generic Composio toolkit+verb rule,
 * verb-aware host tools, then plain humanization — so every callable tool gets
 * a readable chip even when we've never seen it before.
 */
export function toolAction(toolName: string): ToolAction {
  if (EXACT[toolName]) return { ...EXACT[toolName], question: toQuestion(EXACT[toolName].request) };
  if (/^GMAIL_/i.test(toolName)) {
    if (/FETCH|SEARCH|LIST|GET|READ/i.test(toolName))
      return { active: "Searching Gmail", done: "Searched Gmail", request: "Search Gmail", question: toQuestion("Search Gmail") };
    if (/^GMAIL_SEND/i.test(toolName))
      return { active: "Sending email", done: "Sent email", request: "Send email", question: toQuestion("Send email") };
  }
  if (/^SLACK_/i.test(toolName)) {
    if (/SEND|POST/i.test(toolName))
      return { active: "Posting to Slack", done: "Posted to Slack", request: "Post to Slack", question: toQuestion("Post to Slack") };
    if (/FETCH|SEARCH|LIST|GET|HISTORY|READ/i.test(toolName))
      return { active: "Reading Slack", done: "Read Slack", request: "Read Slack", question: toQuestion("Read Slack") };
  }
  const composio = composioAction(toolName);
  if (composio) return composio;
  const host = hostAction(toolName);
  if (host) return host;
  const h = humanize(toolName);
  return { active: h, done: h, request: h, question: toQuestion(h) };
}

/** Back-compat single label (present tense) used by the legacy ToolCall chip. */
export function friendlyLabel(toolName: string): string {
  return toolAction(toolName).active;
}
