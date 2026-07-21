import { describe, expect, it } from "vitest";
import {
  composeGatewayFuel,
  INIT_PURPOSE_HEADER_NAME,
  INIT_PURPOSE_HEADER_VALUE,
} from "./gateway-fuel.js";

describe("composeGatewayFuel", () => {
  it("does nothing when the rung already has its own credential, even if VENDO_API_KEY is set", () => {
    expect(
      composeGatewayFuel({
        env: { VENDO_API_KEY: "vnd_x" },
        ownCredentialAvailable: true,
      }),
    ).toBeNull();
  });

  it("does nothing when no VENDO_API_KEY is set, even without an own credential", () => {
    expect(
      composeGatewayFuel({ env: {}, ownCredentialAvailable: false }),
    ).toBeNull();
  });

  it("does nothing when VENDO_API_KEY is present but blank", () => {
    expect(
      composeGatewayFuel({ env: { VENDO_API_KEY: "   " }, ownCredentialAvailable: false }),
    ).toBeNull();
  });

  it("composes the gateway overlay when unauthenticated and VENDO_API_KEY is set", () => {
    const overlay = composeGatewayFuel({
      env: { VENDO_API_KEY: "vnd_x" },
      ownCredentialAvailable: false,
    });
    expect(overlay).toEqual({
      ANTHROPIC_BASE_URL: "https://console.vendo.run/api/v1",
      ANTHROPIC_AUTH_TOKEN: "vnd_x",
      ANTHROPIC_CUSTOM_HEADERS: "x-vendo-purpose: init",
    });
  });

  it("honors VENDO_CLOUD_URL, matching resolveCloudBaseUrl's endsWith('/api/v1') composition", () => {
    const overlay = composeGatewayFuel({
      env: { VENDO_API_KEY: "vnd_x", VENDO_CLOUD_URL: "http://localhost:3001/" },
      ownCredentialAvailable: false,
    });
    expect(overlay?.ANTHROPIC_BASE_URL).toBe("http://localhost:3001/api/v1");
  });

  it("does not double-append /api/v1 when the configured base URL already ends with it", () => {
    const overlay = composeGatewayFuel({
      env: { VENDO_API_KEY: "vnd_x", VENDO_CLOUD_URL: "http://localhost:3001/api/v1" },
      ownCredentialAvailable: false,
    });
    expect(overlay?.ANTHROPIC_BASE_URL).toBe("http://localhost:3001/api/v1");
  });

  it("exports the shared tag header name/value as the single source of truth", () => {
    expect(INIT_PURPOSE_HEADER_NAME).toBe("x-vendo-purpose");
    expect(INIT_PURPOSE_HEADER_VALUE).toBe("init");
  });

  it("trims VENDO_API_KEY before assigning it to ANTHROPIC_AUTH_TOKEN", () => {
    const overlay = composeGatewayFuel({
      env: { VENDO_API_KEY: "  vnd_x  " },
      ownCredentialAvailable: false,
    });
    expect(overlay?.ANTHROPIC_AUTH_TOKEN).toBe("vnd_x");
  });

  describe("defense in depth: a user-set Anthropic env override is always its own credential", () => {
    it("never overlays when ANTHROPIC_AUTH_TOKEN is set, even if the caller wrongly says ownCredentialAvailable=false", () => {
      expect(
        composeGatewayFuel({
          env: { VENDO_API_KEY: "vnd_x", ANTHROPIC_AUTH_TOKEN: "corp-token" },
          ownCredentialAvailable: false,
        }),
      ).toBeNull();
    });

    it("never overlays when ANTHROPIC_AUTH_TOKEN is paired with a custom ANTHROPIC_BASE_URL (corporate gateway)", () => {
      expect(
        composeGatewayFuel({
          env: {
            VENDO_API_KEY: "vnd_x",
            ANTHROPIC_AUTH_TOKEN: "corp-token",
            ANTHROPIC_BASE_URL: "https://anthropic.corp.example.com",
          },
          ownCredentialAvailable: false,
        }),
      ).toBeNull();
    });

    it("never overlays when CLAUDE_CODE_OAUTH_TOKEN is set", () => {
      expect(
        composeGatewayFuel({
          env: { VENDO_API_KEY: "vnd_x", CLAUDE_CODE_OAUTH_TOKEN: "oauth-token" },
          ownCredentialAvailable: false,
        }),
      ).toBeNull();
    });

    it("never overlays when only ANTHROPIC_BASE_URL is set (no token — e.g. mTLS/proxy auth)", () => {
      expect(
        composeGatewayFuel({
          env: { VENDO_API_KEY: "vnd_x", ANTHROPIC_BASE_URL: "https://anthropic.corp.example.com" },
          ownCredentialAvailable: false,
        }),
      ).toBeNull();
    });

    it("ignores a blank ANTHROPIC_AUTH_TOKEN/CLAUDE_CODE_OAUTH_TOKEN/ANTHROPIC_BASE_URL (still composes)", () => {
      const overlay = composeGatewayFuel({
        env: {
          VENDO_API_KEY: "vnd_x",
          ANTHROPIC_AUTH_TOKEN: "   ",
          CLAUDE_CODE_OAUTH_TOKEN: "",
          ANTHROPIC_BASE_URL: "   ",
        },
        ownCredentialAvailable: false,
      });
      expect(overlay).not.toBeNull();
    });
  });
});
