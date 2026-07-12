import { canonicalJson } from "./jcs.js";
import { sha256Hex } from "./sha256.js";
import type { ToolDescriptor } from "./tools.js";

/** 01-core §4 */
export function descriptorHash(descriptor: ToolDescriptor): string {
  const preimage: Record<string, unknown> = {
    name: descriptor.name,
    description: descriptor.description,
    inputSchema: descriptor.inputSchema,
    risk: descriptor.risk,
  };
  if (descriptor.critical !== undefined) preimage.critical = descriptor.critical;
  return `sha256:${sha256Hex(canonicalJson(preimage))}`;
}
