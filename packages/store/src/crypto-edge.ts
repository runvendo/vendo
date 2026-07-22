/** Edge build of the at-rest secret cipher (see db-edge.ts for the pattern).
 *  The cipher rides node:crypto AES and Buffer keys; hosted deployments keep
 *  secrets on the console side, so edge builds only need honest failure. */
import { VendoError } from "@vendoai/core";

const EDGE_MESSAGE =
  "store secret encryption (VENDO_STORE_ENCRYPTION_KEY) needs the Node runtime; on edge deployments keep "
  + "secrets on the hosted store or a custom adapter";

export function validateEncryptionKey(_value: string): never {
  throw new VendoError("validation", EDGE_MESSAGE);
}

export function encryptSecret(_value: string, _key: unknown, _name: string): never {
  throw new VendoError("validation", EDGE_MESSAGE);
}

export function decryptSecret(_value: string, _key: unknown, _name: string): never {
  throw new VendoError("validation", EDGE_MESSAGE);
}
