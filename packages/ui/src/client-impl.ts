/** Lane A fills this: the fetch/SSE implementation behind the VendoClient interface. */
import type { VendoClient, VendoClientConfig } from "./client.js";

export function createVendoClient(config: VendoClientConfig): VendoClient {
  void config;
  throw new Error("not yet implemented (lane A)");
}
