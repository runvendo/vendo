// @vitest-environment node
// A slot renders on the server too, where there is nothing to report TO: the
// registry write is effect-time only, so a server render must reach the wire
// zero times and still produce the host's own markup.
import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { VendoProvider, createVendoClient } from "../src/index.js";
import { VendoSlot } from "../src/chrome/index.js";

describe("a slot on the server", () => {
  it("reports nothing and renders the host's markup", () => {
    expect(typeof window).toBe("undefined");
    const fetched = vi.spyOn(globalThis, "fetch");
    const client = createVendoClient({ baseUrl: "http://127.0.0.1:1/never" });
    const html = renderToString(
      <VendoProvider client={client}><VendoSlot id="hero"><span>Original hero</span></VendoSlot></VendoProvider>,
    );
    expect(html).toContain("Original hero");
    expect(fetched).not.toHaveBeenCalled();
  });
});
