/** Humanize a tool slug: `set_rule` / `GMAIL_FETCH` -> `Set Rule` / `Gmail Fetch`. */
export function humanize(name: string): string {
  return name
    .replace(/[_-]+/g, " ")
    .trim()
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Present- and past-tense action labels for a tool slug. */
export interface ToolAction {
  active: string;
  done: string;
}

const EXACT: Record<string, ToolAction> = {
  get_transactions: { active: "Reading transactions", done: "Read transactions" },
  create_automation: { active: "Setting up automation", done: "Set up automation" },
  update_automation: { active: "Updating automation", done: "Updated automation" },
  delete_automation: { active: "Deleting automation", done: "Deleted automation" },
  list_automations: { active: "Listing automations", done: "Listed automations" },
  get_automation_runs: { active: "Reading run history", done: "Read run history" },
  pause_automation: { active: "Pausing automation", done: "Paused automation" },
  resume_automation: { active: "Resuming automation", done: "Resumed automation" },
  run_automation_now: { active: "Test-firing automation", done: "Test-fired automation" },
};

/**
 * Map a tool slug to friendly present/past action labels. Branch on the verb so
 * e.g. GMAIL_SEND_EMAIL isn't mislabeled as a search.
 */
export function toolAction(toolName: string): ToolAction {
  if (EXACT[toolName]) return EXACT[toolName];
  if (/^GMAIL_/i.test(toolName)) {
    if (/SEND/i.test(toolName)) return { active: "Sending email", done: "Sent email" };
    if (/FETCH|SEARCH|LIST|GET|READ/i.test(toolName)) return { active: "Searching Gmail", done: "Searched Gmail" };
  }
  if (/^SLACK_/i.test(toolName)) {
    if (/SEND|POST/i.test(toolName)) return { active: "Posting to Slack", done: "Posted to Slack" };
    if (/FETCH|SEARCH|LIST|GET|HISTORY|READ/i.test(toolName)) return { active: "Reading Slack", done: "Read Slack" };
  }
  const h = humanize(toolName);
  return { active: h, done: h };
}

/** Back-compat single label (present tense) used by the legacy ToolCall chip. */
export function friendlyLabel(toolName: string): string {
  return toolAction(toolName).active;
}
