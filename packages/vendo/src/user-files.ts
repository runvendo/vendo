/**
 * The user's file drawer: its path law, its upload cap, and the three tools
 * that read and fill it.
 *
 * Everything here is locked to §3.1's frozen `/user/files` mount, and the lock
 * is structural rather than a check bolted onto a path argument: the tools take
 * a NAME and build the path themselves, so no caller-supplied path exists for a
 * `..` to climb through. `userFilePath` is the single authority the write doors
 * (`POST /files`, `vendo_user_files_put`, `vendo.putUserFile`) and these reads
 * all go through.
 */
import {
  VendoError,
  VENDO_TOOL_TITLES,
  type Principal,
  type ToolDescriptor,
  type ToolOutcome,
  type ToolRegistry,
  type WorkspaceFs,
} from "@vendoai/core";
import { FILES_STORE_MAX_BYTES } from "@vendoai/store";
import type { FilesVenue } from "./compose-store.js";
import type { CreateVendoConfig } from "./types.js";

/** §3.1's frozen drawer: per subject, and outliving every conversation. */
export const USER_FILES = "/user/files";

/** Does this message part address the drawer rather than carry bytes? */
export const isUserFilePath = (path: string): boolean => path.startsWith(`${USER_FILES}/`);

/**
 * The ONE name check every door into the drawer shares, so a file lands and is
 * fetched at the same address by the same rule.
 *
 * A name is a FILE name, never a path. Refusing `/`, `\` and the `.`/`..`
 * dot-segments AT THE SOURCE is what contains the whole feature — the path is
 * built below from a name that provably carries no separator, so there is
 * nothing to escape with. Same posture as the route-tool traversal fix
 * (b9392b92c): reject the segment rather than sanitize it, because the values
 * reaching here are steerable by end-user chat.
 */
export function userFilePath(name: string): string {
  const bad = name.length === 0 || name.length > 200
    || /[/\\]/.test(name) || name === "." || name === ".."
    || [...name].some((char) => char < " ");
  if (bad) {
    throw new VendoError(
      "validation",
      `${JSON.stringify(name)} is not a file name. Send one name — no slashes, no control characters, at most 200 characters — and it lands in the user's files as exactly that.`,
    );
  }
  return `${USER_FILES}/${name}`;
}

/** What one caller may push into the drawer in one go by DEFAULT, and the same
    number at every door into it; `createVendo({ uploadMaxBytes })` moves it. It
    is a DOOR cap, not a storage cap: `vendo.putUserFile` is a trusted server
    caller and is bounded by whatever backs the `files:` adapter instead. There
    is no 413 rung — an over-cap upload is a request the caller can fix, which
    is what `validation` already means everywhere else on this wire. */
export const UPLOAD_MAX_BYTES = 5 * 1024 * 1024;

/** Where the bytes a door ADMITS actually land, per backing. Named in the
    refusal because raising the cap is only half a fix: past 5 MiB with no
    `files:` adapter, the upload clears the door and dies at the store's own
    blob cap instead. */
const BACKING: Record<FilesVenue, string> = {
  byo: "the FilesAdapter wired at createVendo({ files })",
  store: `this deployment's store, which caps one file at ${FILES_STORE_MAX_BYTES} bytes`
    + " — wire createVendo({ files }) with a FilesAdapter (s3Files) before raising the door past it",
};

export const overCap = (name: string, bytes: number, max: number, venue: FilesVenue): VendoError => new VendoError(
  "validation",
  `${JSON.stringify(name)} is ${bytes} bytes and the upload door allows at most ${max}: send a smaller file,`
    + ` or raise createVendo({ uploadMaxBytes }). These bytes land in ${BACKING[venue]}.`,
);

/** The cap and its backing, resolved from config ONCE: the drop door (`POST
    /files`) and the upload tool both read this, so they can never refuse at
    different sizes or name a different destination. The `files` predicate
    belongs to `config`, not to the resolved adapter — `selectFiles` returns one
    FilesAdapter either way, and the interface has no name to ask for. */
export const uploadCapOf = (
  config: Pick<CreateVendoConfig, "uploadMaxBytes" | "files">,
): { uploadMaxBytes: number; files: FilesVenue } => ({
  uploadMaxBytes: config.uploadMaxBytes ?? UPLOAD_MAX_BYTES,
  files: config.files === undefined ? "store" : "byo",
});

/** What the drawer says a file IS. Nothing stores a media type (a workspace row
    is path/owner/bytes/revision, and this ships with no schema change), so the
    name's extension is the whole evidence — which is also what the user sees. */
const MEDIA_TYPES: Readonly<Record<string, string>> = {
  csv: "text/csv",
  tsv: "text/tab-separated-values",
  txt: "text/plain",
  log: "text/plain",
  sql: "text/plain",
  md: "text/markdown",
  json: "application/json",
  ndjson: "application/x-ndjson",
  xml: "application/xml",
  html: "text/html",
  yaml: "text/yaml",
  yml: "text/yaml",
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  zip: "application/zip",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};

const mediaTypeOf = (name: string): string =>
  MEDIA_TYPES[name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? ""] ?? "application/octet-stream";

/** Only a type we can name as text gets its content read back. An unrecognized
    extension declines too: decoding unknown bytes as UTF-8 yields mojibake, and
    a confident answer built on mojibake is worse than an honest refusal. */
const isTextual = (mediaType: string): boolean =>
  mediaType.startsWith("text/") || mediaType === "application/json"
  || mediaType === "application/x-ndjson" || mediaType === "application/xml";

/** The extensions that DO read back, derived from the same predicate the read
    applies — a hand-kept second list could name a type that then refuses. Said
    out loud in the refusal below, because an agent told only "no" cannot act,
    while one told what works can ask the user for a CSV. */
const READABLE_EXTENSIONS = Object.keys(MEDIA_TYPES).filter((ext) => isTextual(MEDIA_TYPES[ext]!)).join(", ");

export const VENDO_USER_FILES_LIST_TOOL = "vendo_user_files_list";
export const VENDO_USER_FILES_READ_TOOL = "vendo_user_files_read";
export const VENDO_USER_FILES_PUT_TOOL = "vendo_user_files_put";

/** One read's window. Line-oriented, because a spreadsheet row cut in half is
    unusable — and sized well under the 32,000-char global tool-output cap
    (tool-bridge's `capOutcome`), whose blunt truncation would replace this
    whole result with a preview string and destroy its structure. */
export const LINES_PER_READ = 200;
export const CHARS_PER_READ = 12_000;

const DRAFT_2020_12 = "https://json-schema.org/draft/2020-12/schema";

const descriptors: ToolDescriptor[] = [
  {
    name: VENDO_USER_FILES_LIST_TOOL,
    title: VENDO_TOOL_TITLES[VENDO_USER_FILES_LIST_TOOL]!,
    description:
      "List the files this user has shared with you. They are saved and stay available in EVERY conversation, "
      + "not just the one they were dropped in — so call this whenever the user refers to something they gave "
      + "you and you cannot see it in this conversation.",
    inputSchema: { $schema: DRAFT_2020_12, type: "object", properties: {}, additionalProperties: false },
    risk: "read",
  },
  {
    name: VENDO_USER_FILES_READ_TOOL,
    title: VENDO_TOOL_TITLES[VENDO_USER_FILES_READ_TOOL]!,
    description:
      "Read one of the files this user has shared with you, by its name. "
      + `It comes back at most ${LINES_PER_READ} lines at a time: when the result says truncated, call again with `
      + "offset set to the nextOffset it gave you, and keep going until it stops. offset counts LINES from the "
      + "start of the file, never characters. "
      + "A file that is not text — a PDF, an image, a spreadsheet workbook, a parquet or database file — answers "
      + "with its type and size and no content: say what it is instead of guessing at what is inside it.",
    inputSchema: {
      $schema: DRAFT_2020_12,
      type: "object",
      properties: {
        name: { type: "string", minLength: 1 },
        offset: { type: "integer", minimum: 0 },
      },
      required: ["name"],
      additionalProperties: false,
    },
    risk: "read",
  },
  {
    name: VENDO_USER_FILES_PUT_TOOL,
    title: VENDO_TOOL_TITLES[VENDO_USER_FILES_PUT_TOOL]!,
    description:
      "Save a file into this user's own files, under a name. It stays available in EVERY conversation, and a "
      + "file already saved under that name is replaced. Send text as content; send anything else base64-encoded "
      + `with encoding set to base64. Any type can be SAVED, but only ${READABLE_EXTENSIONS} read back as text.`,
    inputSchema: {
      $schema: DRAFT_2020_12,
      type: "object",
      properties: {
        name: { type: "string", minLength: 1 },
        content: { type: "string" },
        encoding: { type: "string", enum: ["utf8", "base64"] },
      },
      required: ["name", "content"],
      additionalProperties: false,
    },
    risk: "write",
  },
];

const ok = (output: Record<string, unknown>): ToolOutcome => ({ status: "ok", output: output as never });
const fail = (code: string, message: string): ToolOutcome => ({ status: "error", error: { code, message } });

/** The file's lines, with the phantom element a trailing newline leaves behind
    dropped — otherwise the final window always claims one more line to fetch. */
function linesOf(text: string): string[] {
  const lines = text.split("\n");
  if (lines.length > 1 && lines.at(-1) === "") lines.pop();
  return lines;
}

/** The upload's bytes: text rides as-is, anything else rides base64, because a
    tool call is JSON and JSON has no bytes. */
function uploadBytes(content: string, encoding: unknown): Uint8Array {
  if (encoding !== "base64") return new TextEncoder().encode(content);
  try {
    return Uint8Array.from(atob(content), (char) => char.charCodeAt(0));
  } catch {
    throw new VendoError(
      "validation",
      "content is not valid base64. Send the file's bytes base64-encoded, or leave encoding unset to send text.",
    );
  }
}

/**
 * The drawer's hands, on the ONE registry — guarded, audited and projected
 * exactly like a host tool, with no privileged side door. Each descriptor's
 * `risk` is the whole guard story: `guard.bind` keys off it.
 *
 * Every hand opens the workspace for `ctx.principal` and NOBODY else, so one
 * user's drawer is unreachable from another's session by construction — there
 * is no subject argument to get wrong.
 */
export function createUserFilesTools(
  open: (principal: Principal) => Promise<WorkspaceFs>,
  cap: { uploadMaxBytes: number; files: FilesVenue },
): ToolRegistry {
  return {
    async descriptors() {
      return structuredClone(descriptors);
    },
    async execute(call, ctx): Promise<ToolOutcome> {
      if (call.tool !== VENDO_USER_FILES_LIST_TOOL && call.tool !== VENDO_USER_FILES_READ_TOOL
        && call.tool !== VENDO_USER_FILES_PUT_TOOL) {
        return fail("not-found", `Unknown tool: ${call.tool}`);
      }
      const workspace = await open(ctx.principal);

      if (call.tool === VENDO_USER_FILES_LIST_TOOL) {
        // An empty drawer is an honest answer, not a missing directory.
        if (!await workspace.exists(USER_FILES)) return ok({ files: [] });
        const names = await workspace.readdir(USER_FILES);
        return ok({
          files: await Promise.all(names.map(async (name) => ({
            name,
            bytes: (await workspace.stat(`${USER_FILES}/${name}`)).size,
            mediaType: mediaTypeOf(name),
          }))),
        });
      }

      const args = (call.args ?? {}) as { name?: unknown; offset?: unknown; content?: unknown; encoding?: unknown };
      if (typeof args.name !== "string") return fail("validation", "name must be the file's name");
      // CONTAINMENT: the path is BUILT from the name, and `userFilePath` has
      // already refused anything that is not a bare file name. The upload's
      // decode shares this catch — both refusals are the caller's to fix.
      let path: string;
      let content: Uint8Array | undefined;
      try {
        path = userFilePath(args.name);
        if (call.tool === VENDO_USER_FILES_PUT_TOOL) {
          if (typeof args.content !== "string") {
            return fail("validation", "content must be the file's text, or its bytes base64-encoded with encoding set to base64");
          }
          content = uploadBytes(args.content, args.encoding);
        }
      } catch (error) {
        return fail("validation", (error as Error).message);
      }

      if (content !== undefined) {
        // The SAME cap and the SAME sentence as the drop door (`POST /files`) —
        // a file refused in chat cannot be admitted by asking over MCP instead.
        if (content.byteLength > cap.uploadMaxBytes) {
          return fail("validation", overCap(args.name, content.byteLength, cap.uploadMaxBytes, cap.files).message);
        }
        // Last write wins, exactly like `putUserFile`: "here is the newer
        // export" must work without the user naming files v2, v3, v4.
        await workspace.writeFile(path, content);
        await workspace.commit();
        return ok({ name: args.name, path, bytes: content.byteLength, mediaType: mediaTypeOf(args.name) });
      }

      if (!await workspace.exists(path)) {
        return fail("not-found", `${args.name} is not one of this user's files. List them to see what they have.`);
      }

      const bytes = (await workspace.stat(path)).size;
      const mediaType = mediaTypeOf(args.name);
      // Stored, and honest about it: the bytes are safe and the answer says WHY
      // there is no content and WHICH types would have one, so the agent can ask
      // for a CSV instead of narrating an empty result.
      if (!isTextual(mediaType)) {
        return ok({
          name: args.name,
          bytes,
          mediaType,
          readable: false,
          reason: `${args.name} is saved, but its contents cannot be read back yet.`
            + ` Only these read back as text: ${READABLE_EXTENSIONS}.`
            + " Tell the user what the file is and ask them for one of those if you need what is inside it.",
        });
      }

      const lines = linesOf(await workspace.readFile(path));
      const offset = typeof args.offset === "number" && Number.isInteger(args.offset) && args.offset > 0
        ? Math.min(args.offset, lines.length)
        : 0;
      const window: string[] = [];
      let chars = 0;
      for (let at = offset; at < lines.length && window.length < LINES_PER_READ; at++) {
        const line = lines[at]!;
        // The first line always goes in, however long: `offset` addresses whole
        // lines, so a window allowed to come back empty would never advance.
        if (window.length > 0 && chars + line.length + 1 > CHARS_PER_READ) break;
        window.push(line);
        chars += line.length + 1;
      }
      const nextOffset = offset + window.length;
      return ok({
        name: args.name,
        bytes,
        mediaType,
        lines: lines.length,
        offset,
        content: window.join("\n"),
        ...(nextOffset < lines.length ? { truncated: true, nextOffset } : {}),
      });
    },
  };
}
