import { generateKeyPairSync } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { consoleOutput, type Output, writeText } from "../shared.js";
import { normalizeDomain } from "./registry.js";

export interface VerifyDomainOptions {
  targetDir: string;
  domain?: string;
  keyOut?: string;
  writeWellKnown?: string;
  output?: Output;
}

/** 10-mcp §5 — create registry domain proof while keeping the Ed25519 private
 * seed at an explicit caller-owned path, never at a project default. */
export async function runVerifyDomain(options: VerifyDomainOptions): Promise<number> {
  const output = options.output ?? consoleOutput;
  if (options.domain === undefined) {
    output.error("Pass --domain <domain> for the registry namespace you are proving");
    return 1;
  }
  if (options.keyOut === undefined) {
    output.error("Pass --key-out <path> to choose custody for the private key; keep it outside the repository unless you explicitly intend otherwise");
    return 1;
  }

  try {
    const root = resolve(options.targetDir);
    const domain = normalizeDomain(options.domain);
    const keyPath = resolve(root, options.keyOut);
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const publicDer = publicKey.export({ format: "der", type: "spki" });
    const privateDer = privateKey.export({ format: "der", type: "pkcs8" });
    const publicBytes = publicDer.subarray(-32);
    const privateSeed = privateDer.subarray(-32);
    if (publicBytes.length !== 32 || privateSeed.length !== 32) throw new Error("Ed25519 key export had an unexpected shape");
    const challenge = `v=MCPv1; k=ed25519; p=${publicBytes.toString("base64")}`;

    await mkdir(dirname(keyPath), { recursive: true });
    await writeFile(keyPath, `${privateSeed.toString("hex")}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });

    output.log(`DNS TXT record at ${domain}:`);
    output.log(challenge);
    output.log(`HTTP challenge file at https://${domain}/.well-known/mcp-registry-auth:`);
    output.log(challenge);
    output.log(`Private key written to ${keyPath}; keep it secret and pass its hex value to mcp-publisher only when authenticating.`);

    if (options.writeWellKnown !== undefined) {
      const challengePath = join(resolve(root, options.writeWellKnown), ".well-known", "mcp-registry-auth");
      await writeText(challengePath, `${challenge}\n`);
      output.log(`Wrote ${challengePath}`);
    }
    return 0;
  } catch (error) {
    output.error(`Could not generate domain verification: ${error instanceof Error ? error.message : "unknown error"}`);
    return 1;
  }
}
