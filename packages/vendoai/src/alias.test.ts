import { describe, expect, it } from "vitest";
import { createVendo as canonicalCreateVendo } from "@vendoai/vendo/server";
import { VendoRoot as canonicalVendoRoot } from "@vendoai/vendo/react";
import { createVendo } from "./server.js";
import { VendoRoot } from "./react.js";

describe("vendoai alias", () => {
  it("delegates server and React entry points to @vendoai/vendo", () => {
    expect(createVendo).toBe(canonicalCreateVendo);
    expect(VendoRoot).toBe(canonicalVendoRoot);
  });
});
