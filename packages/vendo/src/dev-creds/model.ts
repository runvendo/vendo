/** The model-credential ladder moved to `@vendoai/harnesses/inference`, so the
 *  standalone agent runtime can fill its model slot without depending on this
 *  package. This file stays as vendo's door onto it: `#dev-creds/model` in
 *  package.json names this module for Node and `model-edge.ts` for the
 *  web-standard runtimes, and that condition is what keeps the Node ladder out
 *  of a Worker bundle (portability gate, FORBIDDEN_INPUTS). */
export {
  bindVendoModelSlots,
  DevModelController,
  devModel,
  importHostModule,
  NO_CREDENTIAL_MESSAGE,
  SLOT_PIN_ENV,
  vendoModel,
  type ConfigurableSlotModels,
  type DevModelOptions,
  type VendoModelOptions,
  type VendoModelSlot,
} from "@vendoai/harnesses/inference";
