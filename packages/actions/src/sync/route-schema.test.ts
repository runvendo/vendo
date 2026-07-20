import { describe, expect, it } from "vitest";
import { createRouteScanState, inferRouteInput, type RouteContext } from "./route-schema.js";

/** Contract test for the collector seam (Task 1 of the route-scan inference
 * plan): with no collectors implemented yet, `inferRouteInput` returns `null`
 * for every route+method — route-scan's zero-behavior-change fallback. */
describe("inferRouteInput (empty seam)", () => {
  it("returns null for a handler with no recognizable input", async () => {
    const route: RouteContext = {
      file: "/repo/app/api/widgets/route.ts",
      source: "export async function POST() { return new Response(); }\n",
      urlPath: "/api/widgets",
      kind: "app",
    };
    const state = createRouteScanState("/repo");

    expect(await inferRouteInput(route, "POST", state)).toBeNull();
    expect(await inferRouteInput(route, "GET", state)).toBeNull();
  });

  it("returns null regardless of route kind or method", async () => {
    const route: RouteContext = {
      file: "/repo/pages/api/thing.ts",
      source: "export default function handler() {}\n",
      urlPath: "/api/thing",
      kind: "pages",
    };
    const state = createRouteScanState("/repo");

    for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE"] as const) {
      expect(await inferRouteInput(route, method, state)).toBeNull();
    }
  });
});
