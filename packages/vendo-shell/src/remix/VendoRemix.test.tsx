import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { VendoRemix } from "./VendoRemix";

describe("VendoRemix", () => {
  it("renders children as an inert passthrough", () => {
    render(
      <VendoRemix id="existing-host-anchor" label="Existing host usage">
        <div data-testid="child">unchanged</div>
      </VendoRemix>,
    );
    expect(screen.getByTestId("child").textContent).toBe("unchanged");
  });
});
