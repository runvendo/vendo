import { describe, it, expect } from "vitest";
import { toolAction, humanize, isCatalogTool } from "./tool-labels";

describe("toolAction", () => {
  it("keeps the hand-tuned host tool labels", () => {
    expect(toolAction("get_transactions")).toEqual({
      active: "Reading transactions",
      done: "Read transactions",
      request: "Read transactions",
      question: "Read transactions?",
    });
    expect(toolAction("create_automation")).toEqual({
      active: "Setting up automation",
      done: "Set up automation",
      request: "Create an automation",
      question: "Create an automation?",
    });
  });

  it("keeps the Gmail/Slack specials", () => {
    expect(toolAction("GMAIL_FETCH_EMAILS").active).toBe("Searching Gmail");
    expect(toolAction("SLACK_SEND_MESSAGE").done).toBe("Posted to Slack");
  });

  it("labels any Composio tool via toolkit + verb + object", () => {
    expect(toolAction("GOOGLECALENDAR_EVENTS_LIST")).toEqual({
      active: "Listing Google Calendar events",
      done: "Listed Google Calendar events",
      request: "List Google Calendar events",
      question: "List Google Calendar events?",
    });
    expect(toolAction("GMAIL_CREATE_EMAIL_DRAFT")).toEqual({
      active: "Creating Gmail email draft",
      done: "Created Gmail email draft",
      request: "Create Gmail email draft",
      question: "Create Gmail email draft?",
    });
    expect(toolAction("NOTION_UPDATE_PAGE")).toEqual({
      active: "Updating Notion page",
      done: "Updated Notion page",
      request: "Update Notion page",
      question: "Update Notion page?",
    });
    expect(toolAction("LINEAR_DELETE_ISSUE")).toEqual({
      active: "Deleting Linear issue",
      done: "Deleted Linear issue",
      request: "Delete Linear issue",
      question: "Delete Linear issue?",
    });
  });

  it("labels a verb-only Composio tool with just the toolkit", () => {
    expect(toolAction("SLACK_API_TEST").active).toBe("Checking Slack");
  });

  it("splits camelCase host tools instead of mashing them into one word", () => {
    expect(toolAction("renderDemoCard").active).toBe("Rendering demo card");
  });

  it("falls back to readable humanization for anything else", () => {
    expect(toolAction("my_custom_thing").active).toBe("My Custom Thing");
  });
});

describe("question-form title", () => {
  it("derives a question from the imperative request form by default", () => {
    expect(toolAction("SLACK_API_TEST").question).toBe("Check Slack?");
  });

  it("exact-override tools get a real hand-authored question", () => {
    expect(toolAction("create_automation").question).toBe("Create an automation?");
  });

  it("Gmail send gets its hand-tuned question form", () => {
    expect(toolAction("GMAIL_SEND_EMAIL").question).toBe("Send email?");
  });
});

describe("humanize", () => {
  it("splits camelCase as well as snake/kebab", () => {
    expect(humanize("renderDemoCard")).toBe("Render Demo Card");
    expect(humanize("set_rule")).toBe("Set Rule");
    expect(humanize("GMAIL_FETCH")).toBe("Gmail Fetch");
  });
});

describe("isCatalogTool", () => {
  it("recognizes tools whose toolkit prefix is in the connect catalog", () => {
    expect(isCatalogTool("GMAIL_SEND_EMAIL")).toBe(true);
    expect(isCatalogTool("SLACK_API_TEST")).toBe(true);
    expect(isCatalogTool("GOOGLECALENDAR_CREATE_EVENT")).toBe(true);
  });

  it("treats everything else as unclassified (MCP/dynamic names keep their badge)", () => {
    expect(isCatalogTool("mystery_tool")).toBe(false);
    expect(isCatalogTool("search_docs")).toBe(false);
    expect(isCatalogTool("ACME_DO_THING")).toBe(false);
    expect(isCatalogTool("transfer_money")).toBe(false);
  });
});
