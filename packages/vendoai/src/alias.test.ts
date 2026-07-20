import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createVendo as canonicalCreateVendo } from "@vendoai/vendo/server";
import { VendoRoot as canonicalVendoRoot } from "@vendoai/vendo/react";
import { jwt as canonicalJwt } from "@vendoai/vendo/auth/jwt";
import { createVendo } from "./server.js";
import { VendoRoot } from "./react.js";
import { jwt } from "./auth-presets/jwt.js";

const packageJsonPath = fileURLToPath(new URL("../package.json", import.meta.url));
const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
  exports: Record<string, unknown>;
};

describe("vendoai alias", () => {
  it("delegates server and React entry points to @vendoai/vendo", () => {
    expect(createVendo).toBe(canonicalCreateVendo);
    expect(VendoRoot).toBe(canonicalVendoRoot);
  });

  it("delegates the jwt auth preset to @vendoai/vendo/auth/jwt", () => {
    expect(jwt).toBe(canonicalJwt);
  });

  it("mirrors all five auth preset subpaths in package.json exports", () => {
    const authSubpaths = ["auth0", "auth-js", "clerk", "jwt", "supabase"];
    for (const preset of authSubpaths) {
      expect(packageJson.exports).toHaveProperty(`./auth/${preset}`);
    }
  });
});
