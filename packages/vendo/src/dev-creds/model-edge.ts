/** Web-standard-runtime build of the dev credential ladder, selected by the
 *  package's `worker`/`workerd`/`edge-light`/`browser` import conditions
 *  (see `#dev-creds/model` in package.json).
 *
 *  The real ladder is Node by design: it resolves the host's own @ai-sdk
 *  provider install via createRequire from the project root, reads `vendo
 *  login` sessions off disk, and anchors on process.cwd(). None of that
 *  exists inside a Worker bundle — Mohamed's field report had the ladder
 *  dying on runtime require.resolve under Wrangler even with VENDO_API_KEY
 *  set. On these runtimes the model seam is explicit by contract: the host
 *  wiring constructs the provider (init generates it; the Cloud gateway is
 *  the stock Anthropic provider pointed at the console). The ladder's edge
 *  build therefore resolves to honest guidance instead of half-working
 *  magic. Keep this module free of node builtins and CLI imports; the
 *  portability gate bundles it. */
import type { LanguageModel } from "ai";
import { log } from "@vendoai/core";

import type { ConfigurableSlotModels, VendoModelOptions, VendoModelSlot } from "./model.js";

export type { VendoModelOptions, VendoModelSlot };

const EDGE_MESSAGE =
  "the vendo model ladder needs Node (it resolves the host's provider install and dev credentials from disk); "
  + "on this runtime pass `models: { default: … }` to createVendo explicitly — with a Vendo Cloud key that is the stock Anthropic "
  + "provider pointed at the console gateway: createAnthropic({ apiKey: VENDO_API_KEY, baseURL: `${VENDO_CLOUD_URL ?? \"https://console.vendo.run\"}/api/v1` })(\"vendo\")";

interface LanguageModelV3Like {
  specificationVersion: "v3";
  provider: string;
  modelId: string;
  supportedUrls: Record<string, RegExp[]>;
  doGenerate(options: unknown): Promise<unknown>;
  doStream(options: unknown): Promise<unknown>;
}

function refusingModel(provider: string, modelId: string): LanguageModel {
  let announced = false;
  const refuse = (): never => {
    if (!announced) {
      announced = true;
      log({
        code: "vendo.model-edge-refused",
        level: "error",
        message: `[vendo] model: ${EDGE_MESSAGE}`,
      });
    }
    throw new Error(EDGE_MESSAGE);
  };
  const model: LanguageModelV3Like = {
    specificationVersion: "v3",
    provider,
    modelId,
    supportedUrls: {},
    doGenerate: () => Promise.resolve().then(refuse),
    doStream: () => Promise.resolve().then(refuse),
  };
  return model as unknown as LanguageModel;
}

/** Same seam as the Node build; announces its unavailability once on first
 *  use through the server log, like the Node ladder's unavailable rung. */
export function vendoModel(name?: string, _options: VendoModelOptions = {}): LanguageModel {
  return refusingModel("vendo", name ?? "vendo-env");
}

/** Export parity with the Node build (the server entry imports it from
 *  "#dev-creds/model"). The edge ladder never resolves, so there is nothing
 *  to bind — a deliberate no-op. */
export function bindVendoModelSlots(
  _model: unknown,
  _models: ConfigurableSlotModels | undefined,
): void {}
