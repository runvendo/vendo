import {
  VendoError,
  validateAppDocument,
  type AppDocument,
  type AppId,
  type VendoRecord,
} from "@vendoai/core";

export const validateDocument = (input: unknown, appId: AppId): AppDocument => {
  const result = validateAppDocument(input);
  if (!result.ok || result.app.id !== appId) {
    const reason = result.ok
      ? `document id ${result.app.id} does not match its app row`
      : result.error.message;
    throw new VendoError("validation", `invalid app document for ${appId}`, { appId, reason });
  }
  return structuredClone(result.app);
};

export const documentFromRecord = (record: VendoRecord): AppDocument =>
  validateDocument(record.data, record.id);

export interface AppRecordWrite {
  id: AppId;
  data: AppDocument;
  refs: { subject: string };
}

export const appRecordInput = (
  app: AppDocument,
  subject: string,
): AppRecordWrite => ({
  id: app.id,
  data: validateDocument(app, app.id),
  refs: { subject },
});
