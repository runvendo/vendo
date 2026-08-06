import { expect, it } from "vitest";

import { getWeather } from "../lib/vendo";

// The generated app re-runs `getWeather` at build time, and the gen checks
// block any app whose live query data contradicts what the model already told
// the user in chat. A random fixture made the README's dashboard step fail on
// nearly every run — the demo data must be stable per city.
it("getWeather returns the same weather for the same city every call", async () => {
  for (const city of ["Paris", "London", "Tokyo"]) {
    const first = await getWeather(city);
    const second = await getWeather(city);
    expect(second).toEqual(first);
  }
});
