import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { createScrubber, scrubbingTransform } from "./exec.js";

/**
 * Everything a child process says reaches an operator's terminal, a Slack thread
 * or a log file on disk, and children echo their environment on some failures.
 * The scrubber is the one thing standing between that and a leaked key.
 */
describe("createScrubber", () => {
  it("redacts every credential-shaped environment value", () => {
    const scrub = createScrubber({ ANTHROPIC_API_KEY: "sk-ant-averylongvalue", VENDO_API_KEY: "vk_live_longvalue" });
    expect(scrub("failed with sk-ant-averylongvalue and vk_live_longvalue"))
      .toBe("failed with <redacted> and <redacted>");
  });

  it("leaves short and non-credential values readable", () => {
    const scrub = createScrubber({ NODE_ENV: "production", API_KEY: "short" });
    expect(scrub("ran with NODE_ENV=production API_KEY=short")).toBe("ran with NODE_ENV=production API_KEY=short");
  });

  it("redacts a user:password remote git echoed back", () => {
    const scrub = createScrubber({});
    expect(scrub("unable to access 'https://x-access-token:ghp_secretvalue@github.com/runvendo/vendo-demos.git/'"))
      .toContain("://<redacted>@github.com");
  });

  // The shape the old rule missed: GitHub's token-only userinfo has NO colon, so
  // `https://ghp_x@github.com/...` — the form `gh auth setup-git` and most CI
  // remotes produce — went through verbatim.
  it("redacts a token-only userinfo, which has no password half", () => {
    const scrub = createScrubber({});
    const scrubbed = scrub("fatal: unable to access 'https://ghp_16CharsOfSecret@github.com/runvendo/vendo-demos.git/': 403");
    expect(scrubbed).not.toContain("ghp_16CharsOfSecret");
    expect(scrubbed).toContain("://<redacted>@github.com");
  });

  it("does not eat an ordinary URL that carries no userinfo", () => {
    const scrub = createScrubber({});
    expect(scrub("polling https://demos.vendo.run/acme")).toBe("polling https://demos.vendo.run/acme");
    expect(scrub("see https://github.com/runvendo/vendo/pull/650")).toContain("github.com/runvendo/vendo/pull/650");
  });
});

describe("scrubbingTransform", () => {
  // The local host boot runs a child with the operator's FULL environment and
  // pipes its output straight to a log file. A Next crash that echoes the
  // environment therefore wrote VENDO_API_KEY to disk in plaintext.
  it("scrubs a child's output on its way to the log file", async () => {
    const scrub = createScrubber({ VENDO_API_KEY: "vk_live_averylongsecret" });
    const chunks: string[] = [];
    const source = Readable.from(["boot ok\n", "crash: env VENDO_API_KEY=vk_live_averylongsecret\n"]);
    const transform = scrubbingTransform(scrub);
    transform.on("data", (chunk: Buffer | string) => { chunks.push(chunk.toString()); });
    await new Promise<void>((resolve, reject) => {
      source.pipe(transform).on("end", resolve).on("error", reject);
    });
    const output = chunks.join("");
    expect(output).not.toContain("vk_live_averylongsecret");
    expect(output).toContain("<redacted>");
    expect(output).toContain("boot ok");
  });
});
