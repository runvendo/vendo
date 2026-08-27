/**
 * The drawer was "everything the user ever gave you". It is now a SHELF: the
 * things they asked to keep. The tools have to say so, or the model will keep
 * putting every dropped file on it.
 */
import {
  VENDO_USER_FILES_LIST_TOOL,
  VENDO_USER_FILES_PUT_TOOL,
  VENDO_USER_FILES_READ_TOOL,
} from "../src/user-files.js";
import { createUserFilesTools } from "../src/user-files.js";
import { describe, expect, it } from "vitest";

const descriptorsOf = async (): Promise<Record<string, string>> => {
  const registry = createUserFilesTools(async () => { throw new Error("not opened"); },
    { uploadMaxBytes: 1, files: "store" });
  return Object.fromEntries((await registry.descriptors()).map((d) => [d.name, d.description]));
};

describe("the shelf's tools say what the shelf is", () => {
  it("tells the model this is the keep-shelf, not the inbox", async () => {
    const described = await descriptorsOf();

    for (const name of [VENDO_USER_FILES_LIST_TOOL, VENDO_USER_FILES_READ_TOOL, VENDO_USER_FILES_PUT_TOOL]) {
      expect(described[name], name).toContain("kept");
    }
    // The put tool is the one that must not be reached for by reflex.
    expect(described[VENDO_USER_FILES_PUT_TOOL]).toContain("asked you to keep");
    // And every one of them points at where a dropped file actually is.
    expect(described[VENDO_USER_FILES_LIST_TOOL]).toContain("/user/threads/");
  });
});
