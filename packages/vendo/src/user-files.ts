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
  type ThreadId,
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

/** Where a dropped file LANDS, for the moments between `POST /files` and the
    turn that claims it. A drop finishes before the conversation it belongs to
    exists (the composer uploads pre-send, and a first turn's thread id is minted
    server-side), so there has to be an address that means "received, not yet
    homed". Nothing but the re-homer and its sweep ever reads it. */
export const USER_UPLOADS = "/user/uploads";

/** Where a file BELONGS once a turn has claimed it: with the conversation, like
    a Claude Code project — so it is in reach of every later turn on that thread,
    and it dies when the thread does. */
export const USER_THREADS = "/user/threads";

/** Does this message part address bytes the SERVER holds, rather than carry
    them? All three addresses answer yes: the shelf, a staged drop, and a
    conversation's own files. */
export const isUserFilePath = (path: string): boolean =>
  path.startsWith(`${USER_FILES}/`)
  || path.startsWith(`${USER_UPLOADS}/`)
  || path.startsWith(`${USER_THREADS}/`);

/**
 * The ONE name check every door into a user's files shares, so a file lands and
 * is fetched at the same address by the same rule.
 *
 * A name is a FILE name, never a path. Refusing `/`, `\` and the `.`/`..`
 * dot-segments AT THE SOURCE is what contains the whole feature — every path
 * below is BUILT from a name that provably carries no separator, so there is
 * nothing to escape with. Same posture as the route-tool traversal fix
 * (b9392b92c): reject the segment rather than sanitize it, because the values
 * reaching here are steerable by end-user chat.
 */
/** The longest leaf any door accepts. Named because the re-homer builds a leaf
    out of one staging already prefixed and has to cut it to the same limit. */
export const MAX_LEAF_NAME = 200;

function leafName(name: string): string {
  const bad = name.length === 0 || name.length > MAX_LEAF_NAME
    || /[/\\]/.test(name) || name === "." || name === ".."
    || [...name].some((char) => char < " ");
  if (bad) {
    throw new VendoError(
      "validation",
      `${JSON.stringify(name)} is not a file name. Send one name — no slashes, no control characters, at most ${MAX_LEAF_NAME} characters — and it lands in the user's files as exactly that.`,
    );
  }
  return name;
}

/** The keep-shelf's address. */
export function userFilePath(name: string): string {
  return `${USER_FILES}/${leafName(name)}`;
}

/** A staged drop's address. The random prefix is OURS, never the caller's: two
    conversations may drop `report.pdf` in the same second and neither may
    overwrite the other before its turn claims it. */
export function uploadStagingPath(name: string): string {
  return `${USER_UPLOADS}/${globalThis.crypto.randomUUID().slice(0, 8)}-${leafName(name)}`;
}

/** Everything one conversation owns. The delete cascade sweeps this whole
    subtree, so nothing may live under it that should outlive the thread.

    The id goes through the SAME rule as a name: it is a path segment like any
    other, and the only shape the wire checks is `thr_` + `.+` (core ids.ts),
    whose `.+` matches a slash. Without this a client-chosen id climbed out of
    this mount — and took the delete cascade's recursive rm with it. */
export const threadFilesDir = (threadId: ThreadId): string => `${USER_THREADS}/${leafName(threadId)}`;

/** One file, homed with its conversation. */
export const threadFilePath = (threadId: ThreadId, name: string): string =>
  `${threadFilesDir(threadId)}/files/${leafName(name)}`;

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
      "List the files this user has kept — their shelf, which outlives every conversation. "
      + "This is NOT where a file they dropped into chat lives: that is in the conversation's own "
      + "files, under /user/threads/<thread>/files, and the bash tool reads it directly. Call this "
      + "when the user refers to something they told you to save.",
    inputSchema: { $schema: DRAFT_2020_12, type: "object", properties: {}, additionalProperties: false },
    risk: "read",
  },
  {
    name: VENDO_USER_FILES_READ_TOOL,
    title: VENDO_TOOL_TITLES[VENDO_USER_FILES_READ_TOOL]!,
    description:
      "Read one of the files this user has kept, by its name. "
      + `It comes back at most ${LINES_PER_READ} lines at a time: when the result says truncated, call again with `
      + "offset set to the nextOffset it gave you, and keep going until it stops. offset counts LINES from the "
      + "start of the file, never characters. "
      + "For a file dropped into THIS conversation, or for anything that is not plain text, use bash instead — "
      + "it reads the same workspace and can parse PDFs, spreadsheets and Word documents.",
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
      "Put a file on this user's shelf, under a name — for something they asked you to keep, so it is "
      + "there in EVERY future conversation. A file already kept under that name is replaced. "
      + "Do NOT use this to stash working files: anything you produce for THIS conversation belongs in "
      + "/user/threads/<thread>/files, which bash writes to directly. "
      + "Send text as content; send anything else base64-encoded with encoding set to base64. "
      + `Any type can be SAVED, but only ${READABLE_EXTENSIONS} read back as text here.`,
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
