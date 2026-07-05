import { describe, expect, it } from "vitest";
import { calendarArgs } from "./composio-fire";

describe("calendarArgs duration normalization", () => {
  it("defaults to a 30-minute event", () => {
    const a = calendarArgs({ summary: "s", start_datetime: "2026-07-02T14:00:00" });
    expect(a).toMatchObject({ event_duration_hour: 0, event_duration_minutes: 30 });
  });

  it("carries minutes >= 60 into hours (Composio rejects 60+ minutes)", () => {
    // The dual-review case: an approved "1-hour call" as event_duration_minutes: 60.
    const a = calendarArgs({ summary: "s", start_datetime: "2026-07-02T14:00:00", event_duration_minutes: 60 });
    expect(a).toMatchObject({ event_duration_hour: 1, event_duration_minutes: 0 });
  });

  it("normalizes a 90-minute request to 1h30m", () => {
    const a = calendarArgs({ summary: "s", start_datetime: "2026-07-02T14:00:00", event_duration_minutes: 90 });
    expect(a).toMatchObject({ event_duration_hour: 1, event_duration_minutes: 30 });
  });

  it("keeps an explicit hour value and passes attendees through", () => {
    const a = calendarArgs({
      summary: "s",
      start_datetime: "2026-07-02T14:00:00",
      event_duration_hour: 2,
      attendees: ["yousef+rivera@vendo.run"],
    });
    expect(a).toMatchObject({ event_duration_hour: 2, event_duration_minutes: 0, attendees: ["yousef+rivera@vendo.run"] });
  });
});
