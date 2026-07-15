import { describe, expect, it } from "vitest";
import { composioToolRisk } from "./composio-risk.js";

/** 04-actions §3 — the curated Composio risk map: metadata hints where
 * Composio provides them, slug-pattern verbs otherwise, conservative `write`
 * default. overrides.json still wins downstream (registry mergeOverride). */
describe("composioToolRisk", () => {
  it("trusts Composio destructive/read-only hint tags", () => {
    expect(composioToolRisk("GMAIL_FETCH_EMAILS", "gmail", ["readOnlyHint"])).toBe("read");
    expect(composioToolRisk("GITHUB_DELETE_REPO", "github", ["destructiveHint"])).toBe("destructive");
    // An update hint is still a write.
    expect(composioToolRisk("GITHUB_UPDATE_ISSUE", "github", ["updateHint", "important"])).toBe("write");
  });

  it("maps destructive slug verbs to destructive anywhere in the slug", () => {
    for (const slug of [
      "GMAIL_DELETE_MESSAGE",
      "GITHUB_REMOVE_COLLABORATOR",
      "NOTION_DESTROY_BLOCK",
      "SLACK_REVOKE_TOKEN",
      "AWS_TERMINATE_INSTANCE",
      "DB_DROP_TABLE",
      "DISK_WIPE_VOLUME",
      "QUEUE_PURGE_MESSAGES",
    ]) expect(composioToolRisk(slug, slug.split("_")[0]!.toLowerCase())).toBe("destructive");
  });

  it("a destructive slug verb beats a stale read-only hint (conservative direction)", () => {
    expect(composioToolRisk("GMAIL_DELETE_DRAFT", "gmail", ["readOnlyHint"])).toBe("destructive");
  });

  it("maps leading read verbs to read", () => {
    for (const slug of [
      "GMAIL_FETCH_EMAILS",
      "GMAIL_LIST_THREADS",
      "GITHUB_GET_REPO",
      "NOTION_SEARCH_PAGES",
      "SLACK_FIND_USER",
      "CRM_RETRIEVE_CONTACT",
      "SHEETS_LOOKUP_ROW",
    ]) expect(composioToolRisk(slug, slug.split("_")[0]!.toLowerCase())).toBe("read");
  });

  it("a read verb later in the slug does not make a write read", () => {
    // The leading verb decides; SEND is not a read verb.
    expect(composioToolRisk("GMAIL_SEND_LIST_SUBSCRIPTION", "gmail")).toBe("write");
    // GET_DELETED_* reads deleted items; DELETE token still wins conservatively.
    expect(composioToolRisk("GMAIL_GET_DELETED_MESSAGES", "gmail")).toBe("destructive");
  });

  it("defaults everything else to write, with or without the toolkit prefix", () => {
    expect(composioToolRisk("GMAIL_SEND_EMAIL", "gmail")).toBe("write");
    expect(composioToolRisk("SEND_EMAIL", "gmail")).toBe("write");
    expect(composioToolRisk("CREATE_ISSUE", "github")).toBe("write");
    expect(composioToolRisk("", "gmail")).toBe("write");
  });

  it("reads slugs case-insensitively and without the toolkit prefix", () => {
    expect(composioToolRisk("gmail_fetch_emails", "GMAIL")).toBe("read");
    expect(composioToolRisk("fetch_emails", "gmail")).toBe("read");
  });
});
