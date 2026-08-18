/**
 * `Intl`, asserted from inside the VM — the host's real one, reached across the
 * wall.
 *
 * QuickJS carries no ICU, so before the bridge every locale-aware format in there
 * degraded to `toString()`: the one idiom every model writes for money,
 * `cents.toLocaleString("en-US", { style: "currency", currency: "USD" })`, painted
 * `4200` where a browser paints `$4,200.00`. So the tests below are literal
 * strings on purpose — a browser's answer, written out — because the whole point
 * of the bridge is that a screen in the box prints what the same screen prints in
 * a tab.
 *
 * The other half is DETERMINISM, and it is the reason the locale and the zone are
 * boot options rather than the machine's: the same screen over the same data has
 * to print the same string on a laptop in Los Angeles and on a worker in Iowa. The
 * instant every test here formats — 2026-08-17T01:30:00Z — is chosen because it
 * falls on the 17th in UTC and the 16th in the Americas, so a leak of the
 * machine's own zone is a failing assertion and not a coin flip.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { bootScreen, ScreenError, warmScreenEngine } from "../../../../src/contract/genui/component/index.js";
import { bootTsx, CATALOG, compileScreen, textsOf } from "./screen-fixture.test-util.js";

beforeAll(async () => {
  await warmScreenEngine();
});

/** The 17th in UTC, the 16th in every American zone. */
const AT = Date.UTC(2026, 7, 17, 1, 30);

/** The zone the wall defaults to, as the host spells it — for the few strings
 *  whose spacing moves with the ICU the runner happens to carry. */
const HOST = { timeZone: "UTC" } as const;

/** One screen whose whole job is to say what it formatted. */
const says = (body: string, wall: { now?: number; locale?: string; timeZone?: string } = {}): string => {
  const screen = bootScreen({
    compiledSource: compileScreen(`
import { Text } from "@vendo/screen";
export default function S() {
  ${body}
  return <Text text={String(answer)} />;
}`),
    queries: {},
    catalog: CATALOG,
    now: AT,
    ...wall,
  });
  try {
    return textsOf(screen.tree()).join("");
  } finally {
    screen.dispose();
  }
};

const refuses = (body: string): ScreenError => {
  try {
    says(body);
  } catch (error) {
    if (error instanceof ScreenError) return error;
    throw error;
  }
  throw new Error("expected the screen to be refused");
};

describe("money and numbers", () => {
  it("formats the idiom a model writes for money", () => {
    expect(says(`const answer = (4200).toLocaleString("en-US", { style: "currency", currency: "USD" });`))
      .toBe("$4,200.00");
    expect(says(`const answer = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(42.5);`))
      .toBe("$42.50");
    // Written without `new`, which is how half of them are written and how both
    // constructors really work.
    expect(says(`const answer = Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(1234.5);`))
      .toBe("$1,234.50");
  });

  it("groups, rounds and percents the way the standard says", () => {
    expect(says(`const answer = (1234567).toLocaleString("en-US");`)).toBe("1,234,567");
    expect(says(`const answer = (0.4213).toLocaleString("en-US", { style: "percent", maximumFractionDigits: 1 });`))
      .toBe("42.1%");
    expect(says(`const answer = (1234.5678).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });`))
      .toBe("1,234.57");
  });

  it("formats a locale the screen names, in that locale's own punctuation", () => {
    // Compared against the host's own answer rather than a literal: the space
    // before the euro sign is a no-break space whose codepoint moves with ICU,
    // and what is being asserted is that the HOST answered, not which ICU it has.
    expect(says(`const answer = new Intl.NumberFormat("de-DE", { style: "currency", currency: "EUR" }).format(1234.567);`))
      .toBe(new Intl.NumberFormat("de-DE", { style: "currency", currency: "EUR" }).format(1234.567));
  });

  it("prints NaN and Infinity, which JSON could not have carried", () => {
    // A value crosses the wall as its decimal spelling for exactly this: as JSON
    // both would have arrived as `null` and formatted as "0".
    expect(says(`const answer = (0 / 0).toLocaleString("en-US");`)).toBe("NaN");
    expect(says(`const answer = (1 / 0).toLocaleString("en-US");`)).toBe("∞");
  });

  it("hands back the parts when a screen asks for them", () => {
    expect(says(`const answer = JSON.stringify(
      new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).formatToParts(4200)
        .map(function (part) { return part.type + ":" + part.value; }),
    );`)).toBe(JSON.stringify(["currency:$", "integer:4", "group:,", "integer:200", "decimal:.", "fraction:00"]));
  });

  it("needs no clock — a number has no zone and no day", () => {
    expect(textsOf(bootTsx(`
import { Text } from "@vendo/screen";
export default function S() {
  return <Text text={(4200).toLocaleString("en-US", { style: "currency", currency: "USD" })} />;
}`).tree())).toEqual(["$4,200.00"]);
  });
});

describe("dates and times", () => {
  it("formats a date the screen carries, long and short", () => {
    expect(says(`const answer = new Date(${AT}).toLocaleDateString("en-US");`)).toBe("8/17/2026");
    expect(says(`const answer = new Date(${AT}).toLocaleDateString("en-US", { month: "short", day: "numeric" });`))
      .toBe("Aug 17");
    expect(says(`const answer = new Intl.DateTimeFormat("en-US", { dateStyle: "medium" }).format(new Date(${AT}));`))
      .toBe("Aug 17, 2026");
  });

  it("formats the time and the stamp the way the host's own methods do", () => {
    expect(says(`const answer = new Date(${AT}).toLocaleTimeString("en-US");`))
      .toBe(new Date(AT).toLocaleTimeString("en-US", HOST));
    expect(says(`const answer = new Date(${AT}).toLocaleString("en-US");`))
      .toBe(new Date(AT).toLocaleString("en-US", HOST));
    // Each of the three defaults to different components when a screen names
    // none, which is why each is answered by the host's own method.
    expect(says(`const answer = new Date(${AT}).toLocaleDateString("en-US");`))
      .not.toBe(says(`const answer = new Date(${AT}).toLocaleString("en-US");`));
  });

  it("reads the FROZEN clock when a screen formats no particular date", () => {
    expect(says(`const answer = new Intl.DateTimeFormat("en-US").format();`)).toBe("8/17/2026");
    expect(says(`const answer = new Date().toLocaleDateString("en-US");`)).toBe("8/17/2026");
  });

  it("hands back the parts and the resolved wall", () => {
    expect(says(`const answer = JSON.stringify(
      new Intl.DateTimeFormat("en-US").formatToParts(new Date(${AT}))
        .filter(function (part) { return part.type !== "literal"; })
        .map(function (part) { return part.type + ":" + part.value; }),
    );`)).toBe(JSON.stringify(["month:8", "day:17", "year:2026"]));
    expect(says(`const answer = new Intl.DateTimeFormat("en-US").resolvedOptions().timeZone;`)).toBe("UTC");
  });

  it("has no date to format without a clock, and says which one is missing", () => {
    // The clock is the seal's, not the bridge's: a screen the host gave no `now`
    // has no `Date` at all, and reaching for one reads the same as every other
    // clock read in there.
    let thrown: unknown;
    try {
      bootTsx(`
import { Text } from "@vendo/screen";
export default function S() {
  return <Text text={new Intl.DateTimeFormat("en-US").format()} />;
}`).dispose();
    } catch (error) {
      thrown = error;
    }
    expect((thrown as ScreenError).message).toContain("'Date' is not defined");
  });
});

describe("elapsed time", () => {
  it("phrases an interval the way a browser phrases it", () => {
    expect(says(`const answer = new Intl.RelativeTimeFormat("en-US").format(-2, "hour");`)).toBe("2 hours ago");
    expect(says(`const answer = new Intl.RelativeTimeFormat("en-US").format(3, "day");`)).toBe("in 3 days");
    expect(says(`const answer = new Intl.RelativeTimeFormat("en-US").format(-1, "minute");`)).toBe("1 minute ago");
    // Written without `new`, which is how half of them are written.
    expect(says(`const answer = Intl.RelativeTimeFormat("en-US").format(-30, "second");`)).toBe("30 seconds ago");
  });

  it("counts back from the FROZEN clock — the phrasing a screen really writes", () => {
    // What a timestamp column is: subtract the row's instant from now, hand the
    // difference to `RelativeTimeFormat`. Both halves are the host's, and the
    // clock is the one this boot pinned, so "2 hours ago" is the same two hours
    // on every machine.
    expect(says(`
  const hours = Math.round((Date.parse("2026-08-16T23:30:00Z") - Date.now()) / 3600000);
  const answer = new Intl.RelativeTimeFormat("en-US").format(hours, "hour");`)).toBe("2 hours ago");
  });

  it("takes the option that turns a count into a word", () => {
    expect(says(`const answer = new Intl.RelativeTimeFormat("en-US", { numeric: "auto" }).format(-1, "day");`))
      .toBe("yesterday");
    expect(says(`const answer = new Intl.RelativeTimeFormat("en-US", { numeric: "auto" }).format(1, "week");`))
      .toBe("next week");
  });

  it("hands back the parts and the resolved options", () => {
    // Against the host's own answer rather than a literal: where the number sits
    // inside the phrase is the host's business, and what is asserted is that the
    // host answered at all.
    expect(says(`const answer = JSON.stringify(
      new Intl.RelativeTimeFormat("en-US").formatToParts(-2, "hour")
        .map(function (part) { return part.type + ":" + part.value; }),
    );`)).toBe(JSON.stringify(new Intl.RelativeTimeFormat("en-US").formatToParts(-2, "hour")
      .map((part) => `${part.type}:${part.value}`)));
    expect(says(`const answer = new Intl.RelativeTimeFormat("en-US").resolvedOptions().numeric;`)).toBe("always");
  });
});

describe("plurals", () => {
  it("names the category a count takes, in the locale's own rules", () => {
    expect(says(`const answer = new Intl.PluralRules("en-US").select(1);`)).toBe("one");
    expect(says(`const answer = new Intl.PluralRules("en-US").select(0);`)).toBe("other");
    expect(says(`const answer = new Intl.PluralRules("en-US").select(2);`)).toBe("other");
    // Polish has a category English does not, which is the whole reason
    // `count === 1 ? "item" : "items"` is not the answer.
    expect(says(`const answer = new Intl.PluralRules("pl-PL").select(2);`)).toBe("few");
  });

  it("selects an ordinal when the screen asks for one", () => {
    expect(says(`const answer = new Intl.PluralRules("en-US", { type: "ordinal" }).select(2);`)).toBe("two");
    expect(says(`const answer = new Intl.PluralRules("en-US", { type: "ordinal" }).select(3);`)).toBe("few");
    expect(says(`const answer = new Intl.PluralRules("en-US").resolvedOptions().type;`)).toBe("cardinal");
  });

  it("is the half of '1 item / 2 items' a screen cannot get wrong", () => {
    const label = (count: number) => says(`
  const count = ${count};
  const answer = count + " " + (new Intl.PluralRules("en-US").select(count) === "one" ? "invoice" : "invoices");`);
    expect(label(1)).toBe("1 invoice");
    expect(label(2)).toBe("2 invoices");
  });
});

describe("the wall", () => {
  it("defaults to the HOST's zone, never the machine the VM runs on", () => {
    // 01:30Z is the 16th everywhere in the Americas, so this string is the
    // pinned zone's answer and could not be the runner's.
    expect(says(`const answer = new Date(${AT}).toLocaleDateString("en-US");`)).toBe("8/17/2026");
    expect(new Date(AT).toLocaleDateString("en-US", { timeZone: "America/New_York" })).toBe("8/16/2026");
  });

  it("takes the zone and the locale the host pinned", () => {
    expect(says(`const answer = new Date(${AT}).toLocaleDateString("en-US");`, { timeZone: "America/New_York" }))
      .toBe("8/16/2026");
    expect(says(`const answer = (1234.5).toLocaleString();`, { locale: "de-DE" }))
      .toBe((1234.5).toLocaleString("de-DE"));
    expect(says(`const answer = new Intl.DateTimeFormat().resolvedOptions().timeZone;`, { timeZone: "Asia/Tokyo" }))
      .toBe("Asia/Tokyo");
  });

  it("carries the elapsed-time and plural formats too, and prints the same twice", () => {
    expect(says(`const answer = new Intl.RelativeTimeFormat().format(-2, "hour");`, { locale: "de-DE" }))
      .toBe(new Intl.RelativeTimeFormat("de-DE").format(-2, "hour"));
    expect(says(`const answer = new Intl.PluralRules().select(2);`, { locale: "pl-PL" })).toBe("few");
    // Two boots, one string: neither format reads a clock or a zone of its own,
    // and both are answered out here whatever machine the VM sits on.
    const phrase = `const answer = new Intl.RelativeTimeFormat("en-US", { numeric: "auto" }).format(-1, "day")
      + " / " + new Intl.PluralRules("en-US").select(1);`;
    expect(says(phrase)).toBe(says(phrase));
    expect(says(phrase)).toBe("yesterday / one");
  });

  it("honours what the SCREEN names over what the host pinned — it wrote it", () => {
    expect(says(
      `const answer = new Date(${AT}).toLocaleDateString("en-GB", { timeZone: "Asia/Tokyo" });`,
      { locale: "de-DE", timeZone: "America/New_York" },
    )).toBe(new Date(AT).toLocaleDateString("en-GB", { timeZone: "Asia/Tokyo" }));
  });

  it("paints the same twice on one wall, and differently on another", () => {
    const money = `const answer = new Date(${AT}).toLocaleString("en-US") + " " + (4200).toLocaleString("en-US", { style: "currency", currency: "USD" });`;
    expect(says(money)).toBe(says(money));
    expect(says(money, { timeZone: "Asia/Tokyo" })).not.toBe(says(money));
  });

  it("cannot be reached except through Intl — the bridge is gone by the time a screen runs", () => {
    expect(says(`const answer = typeof globalThis.__vendo_intl;`)).toBe("undefined");
  });

  it("refuses a format the host refuses, in the host's own words", () => {
    const error = refuses(`const answer = (1).toLocaleString("en-US", { style: "currency", currency: "USDD" });`);

    expect(error.kind).toBe("boot");
    expect(error.message).toContain("Invalid currency code");
  });
});
