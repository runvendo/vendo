import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { option, positionals } from "./args.js";
import { cloudFetch, type CloudFetchOptions } from "./client.js";
import {
  deleteCloudSession,
  writeCloudSession,
  type CloudSession,
} from "./session.js";
import { cloudConsoleOutput, errorMessage, printJson } from "./output.js";
import type { Output } from "../shared.js";

type CloudFetcher = (path: string, options?: CloudFetchOptions) => Promise<unknown>;

export interface CloudAuthOptions {
  output?: Output;
  fetcher?: CloudFetcher;
  writeSession?: (session: CloudSession) => Promise<void>;
  deleteSession?: () => Promise<void>;
  promptOtp?: (prompt: string) => Promise<string>;
  home?: string;
  env?: Record<string, string | undefined>;
}

function syntheticSession(token: string): CloudSession {
  try {
    const payload = token.split(".")[1];
    if (!payload) return { access_token: token };
    const normalized = payload.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(payload.length / 4) * 4, "=");
    const value = JSON.parse(atob(normalized)) as { exp?: unknown };
    return typeof value.exp === "number"
      ? { access_token: token, expires_at: value.exp }
      : { access_token: token };
  } catch {
    return { access_token: token };
  }
}

function verifiedSession(value: unknown): CloudSession {
  const candidate = typeof value === "object" && value !== null && "session" in value
    ? (value as { session: unknown }).session
    : value;
  if (typeof candidate !== "object" || candidate === null
    || typeof (candidate as Partial<CloudSession>).access_token !== "string"
    || typeof (candidate as Partial<CloudSession>).refresh_token !== "string"
    || typeof (candidate as Partial<CloudSession>).expires_at !== "number") {
    throw new Error("Vendo Cloud returned an invalid session");
  }
  const session = candidate as Required<CloudSession>;
  return {
    access_token: session.access_token,
    refresh_token: session.refresh_token,
    expires_at: session.expires_at,
  };
}

async function interactiveOtp(prompt: string): Promise<string> {
  const readline = createInterface({ input: stdin, output: stdout });
  try {
    return await readline.question(`${prompt}: `);
  } finally {
    readline.close();
  }
}

export async function runLogin(args: string[], options: CloudAuthOptions = {}): Promise<number> {
  const output = options.output ?? cloudConsoleOutput;
  const token = option(args, "--token");
  const writeSession = options.writeSession ?? ((session) => writeCloudSession(session, { home: options.home }));
  if (token) {
    try {
      await writeSession(syntheticSession(token));
      printJson(output, { loggedIn: true, mode: "token" });
      return 0;
    } catch (error) {
      output.error(errorMessage(error));
      return 1;
    }
  }

  const email = positionals(args, ["--token", "--api-url"])[0];
  if (!email) {
    output.error("Cloud login requires an email or --token <jwt>");
    return 1;
  }

  const fetcher = options.fetcher ?? ((path, fetchOptions) => cloudFetch(path, fetchOptions));
  const common = {
    apiUrl: option(args, "--api-url"),
    env: options.env ?? process.env,
  };
  try {
    await fetcher("/api/v1/auth/otp/start", { ...common, method: "POST", body: { email } });
    const otp = (await (options.promptOtp ?? interactiveOtp)(`Enter the code sent to ${email}`)).trim();
    if (!/^\d{6,10}$/.test(otp)) throw new Error("Email OTP must be a 6-10 digit code");
    const result = await fetcher("/api/v1/auth/otp/verify", {
      ...common,
      method: "POST",
      body: { email, token: otp },
    });
    await writeSession(verifiedSession(result));
    printJson(output, { loggedIn: true, mode: "email", email });
    return 0;
  } catch (error) {
    output.error(errorMessage(error));
    return 1;
  }
}

export async function runLogout(_args: string[], options: CloudAuthOptions = {}): Promise<number> {
  const output = options.output ?? cloudConsoleOutput;
  try {
    await (options.deleteSession ?? (() => deleteCloudSession({ home: options.home })))();
    printJson(output, { loggedOut: true });
    return 0;
  } catch (error) {
    output.error(errorMessage(error));
    return 1;
  }
}

export async function runWhoami(args: string[], options: CloudAuthOptions = {}): Promise<number> {
  const output = options.output ?? cloudConsoleOutput;
  const fetcher = options.fetcher ?? ((path, fetchOptions) => cloudFetch(path, fetchOptions));
  try {
    const orgs = await fetcher("/api/v1/orgs", {
      auth: "user",
      apiUrl: option(args, "--api-url"),
      accessToken: option(args, "--token"),
      home: options.home,
      env: options.env ?? process.env,
    });
    printJson(output, orgs);
    return 0;
  } catch (error) {
    output.error(errorMessage(error));
    return 1;
  }
}
