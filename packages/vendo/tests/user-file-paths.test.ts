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

  it("applies it to the THREAD ID too, which is a segment like any other", () => {
    // The containment argument in user-files.ts is that every path is BUILT from
    // parts that provably carry no separator. The id is one of those parts, and
    // the only shape the wire ever checked is `/^thr_.+$/` (core/src/ids.ts:51),
    // whose `.+` matches a slash — so a client-supplied id climbed out of
    // `/user/threads` and homed a drop on the shelf, and the thread's own delete
    // cascade aimed its recursive rm at whatever the `..`s resolved to.
    for (const id of ["thr_a/../..", "thr_a/b", "..", ""]) {
      expect(() => threadFilesDir(id), id).toThrow();
      expect(() => threadFilePath(id, "ledger.csv"), id).toThrow();
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
