/**
 * Where a user's bytes can live, and the ONE name rule all three share.
 */
import { describe, expect, it } from "vitest";
import {
  isUserFilePath,
  threadFilesDir,
  threadFilePath,
  uploadStagingPath,
  userFilePath,
  USER_UPLOADS,
} from "../src/user-files.js";

describe("the three addresses a user's file can have", () => {
  it("stages a drop under a random prefix, so two drops of one name cannot collide", () => {
    const first = uploadStagingPath("ledger.csv");
    const second = uploadStagingPath("ledger.csv");

    expect(first).not.toBe(second);
    expect(first.startsWith(`${USER_UPLOADS}/`)).toBe(true);
    expect(first.endsWith("-ledger.csv")).toBe(true);
  });

  it("homes a file with its conversation", () => {
    expect(threadFilesDir("thr_abc")).toBe("/user/threads/thr_abc");
    expect(threadFilePath("thr_abc", "ledger.csv")).toBe("/user/threads/thr_abc/files/ledger.csv");
  });

  it("keeps the shelf exactly where it was", () => {
    expect(userFilePath("ledger.csv")).toBe("/user/files/ledger.csv");
  });

  it("applies the SAME name rule at all three doors", () => {
    for (const name of ["../escape.csv", "nested/ledger.csv", "..", ""]) {
      expect(() => uploadStagingPath(name), name).toThrow();
      expect(() => threadFilePath("thr_abc", name), name).toThrow();
      expect(() => userFilePath(name), name).toThrow();
    }
  });

  it("recognises all three as server-held addresses, and nothing else", () => {
    expect(isUserFilePath("/user/files/a.csv")).toBe(true);
    expect(isUserFilePath("/user/uploads/9f2a1c04-a.csv")).toBe(true);
    expect(isUserFilePath("/user/threads/thr_abc/files/a.csv")).toBe(true);
    expect(isUserFilePath("data:text/csv;base64,YQ==")).toBe(false);
    expect(isUserFilePath("https://cdn.test/a.csv")).toBe(false);
  });
});
