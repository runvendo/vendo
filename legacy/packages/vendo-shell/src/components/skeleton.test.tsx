import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { Skeleton, skeletonShape } from "./Skeleton";

describe("skeletonShape", () => {
  it("maps known component names to archetypes", () => {
    expect(skeletonShape("SpendChart")).toBe("chart");
    expect(skeletonShape("TransactionsTable")).toBe("table");
    expect(skeletonShape("ActivityList")).toBe("list");
    expect(skeletonShape("BalanceStat")).toBe("stat");
  });

  it("falls back to a generic card for unknown or missing names", () => {
    expect(skeletonShape("MysteryWidget")).toBe("card");
    expect(skeletonShape(undefined)).toBe("card");
  });
});

describe("Skeleton", () => {
  it("renders the matched shape as a data attribute", () => {
    const { rerender } = render(<Skeleton name="SpendChart" />);
    expect(document.querySelector(".fl-skeleton")?.getAttribute("data-shape")).toBe("chart");
    rerender(<Skeleton name="TransactionsTable" />);
    expect(document.querySelector(".fl-skeleton")?.getAttribute("data-shape")).toBe("table");
  });
});
