import {
  VendoError,
  canonicalJson,
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

/** The vendo_apps row shape (02-store §2: id, subject, enabled, doc). The
 *  store's reserved records("vendo_apps") routing speaks exactly this — the
 *  document alone is NOT the row; ownership and the automations arm/disarm
 *  bit ride beside it. */
export interface AppRowData {
  subject: string;
  enabled: boolean;
  doc: AppDocument;
}

/** Trigger edits invalidate enable-time capture, cursor, and webhook state.
 *  Canonical comparison — key order must not cause a spurious disarm. */
export const enabledAfterDocumentEdit = (
  previous: AppDocument,
  next: AppDocument,
  enabled: boolean,
): boolean => {
  const canon = (trigger: AppDocument["trigger"]): string =>
    trigger === undefined ? "" : canonicalJson(trigger);
  return canon(previous.trigger) === canon(next.trigger) && enabled;
};

export const rowFromRecord = (record: VendoRecord): AppRowData => {
  const data = record.data as Partial<AppRowData> | null;
  if (
    data === null || typeof data !== "object"
    || typeof data.subject !== "string"
    || typeof data.enabled !== "boolean"
    || data.doc === undefined
  ) {
    throw new VendoError("validation", `invalid app row for ${record.id}`, { appId: record.id });
  }
  return {
    subject: data.subject,
    enabled: data.enabled,
    doc: validateDocument(data.doc, record.id),
  };
};

export const documentFromRecord = (record: VendoRecord): AppDocument =>
  rowFromRecord(record).doc;

export interface AppRecordWrite {
  id: AppId;
  data: AppRowData;
  refs: { subject: string };
}

export const appRecordInput = (
  app: AppDocument,
  subject: string,
  enabled = false,
): AppRecordWrite => ({
  id: app.id,
  data: { subject, enabled, doc: validateDocument(app, app.id) },
  refs: { subject },
});
