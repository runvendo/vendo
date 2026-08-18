import { promises as fs } from "node:fs";
import type { ExtractedTool } from "../formats.js";
import { extractOpenApiDocument, openApiDocument, openApiDocumentMountPath } from "../openapi-document.js";

/** The file-reading half of OpenAPI extraction. Everything document-level is
 *  the pure ../openapi-document.js module, which `openApiConnector` shares. */
async function readDocument(specPath: string): Promise<Record<string, unknown>> {
  return openApiDocument(await fs.readFile(specPath, "utf8"));
}

export async function openApiMountPath(specPath: string): Promise<string> {
  return openApiDocumentMountPath(await readDocument(specPath));
}

export async function extractOpenApi(specPath: string): Promise<ExtractedTool[]> {
  return extractOpenApiDocument(await readDocument(specPath));
}
