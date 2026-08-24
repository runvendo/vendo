/**
 * A file part either CARRIES its bytes or NAMES where the server holds them.
 * The pill's download link exists only in the first case, so the predicate has to
 * recognise all three addresses — a thread's own files, a staged drop, and the
 * keep-shelf — not just the one that existed when it was written.
 */
import { describe, expect, it } from "vitest";
import { isSavedFile } from "../../src/chrome/thread/attachments.js";

describe("which file parts the server holds", () => {
  it("recognises every workspace address", () => {
    expect(isSavedFile("/user/files/kept.csv")).toBe(true);
    expect(isSavedFile("/user/uploads/9f2a1c04-ledger.csv")).toBe(true);
    expect(isSavedFile("/user/threads/thr_abc/files/ledger.csv")).toBe(true);
  });

  it("still treats a part carrying its own bytes as downloadable", () => {
    expect(isSavedFile("data:text/csv;base64,YQ==")).toBe(false);
    expect(isSavedFile("blob:https://host.test/2f1c")).toBe(false);
    expect(isSavedFile("https://cdn.test/a.csv")).toBe(false);
  });
});
