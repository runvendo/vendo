/**
 * The user's file drawer: its path law, and the two tools that read it.
 *
 * Everything here is locked to §3.1's frozen `/user/files` mount, and the lock
 * is structural rather than a check bolted onto a path argument: the tools take
 * a NAME and build the path themselves, so no caller-supplied path exists for a
 * `..` to climb through. `userFilePath` is the single authority the write doors
 * (`POST /files`, `vendo.putUserFile`) and these reads all go through.
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

export const VENDO_USER_FILES_LIST_TOOL = "vendo_user_files_list";
export const VENDO_USER_FILES_READ_TOOL = "vendo_user_files_read";

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
      + "A file that is not text — a PDF, an image, a spreadsheet workbook — answers with its type and size and "
      + "no content: say what it is instead of guessing at what is inside it.",
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

/**
 * The drawer's read hands, on the ONE registry — guarded, audited and projected
 * exactly like a host tool, with no privileged side door. `risk: "read"` is the
 * whole guard story: `guard.bind` keys off it.
 */
export function createUserFilesTools(
  open: (principal: Principal) => Promise<WorkspaceFs>,
): ToolRegistry {
  return {
    async descriptors() {
      return structuredClone(descriptors);
    },
    async execute(call, ctx): Promise<ToolOutcome> {
      if (call.tool !== VENDO_USER_FILES_LIST_TOOL && call.tool !== VENDO_USER_FILES_READ_TOOL) {
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

      const args = (call.args ?? {}) as { name?: unknown; offset?: unknown };
      if (typeof args.name !== "string") return fail("validation", "name must be the file's name");
      // CONTAINMENT: the path is BUILT from the name, and `userFilePath` has
      // already refused anything that is not a bare file name.
      let path: string;
      try {
        path = userFilePath(args.name);
      } catch (error) {
        return fail("validation", (error as Error).message);
      }
      if (!await workspace.exists(path)) {
        return fail("not-found", `${args.name} is not one of this user's files. List them to see what they have.`);
      }

      const bytes = (await workspace.stat(path)).size;
      const mediaType = mediaTypeOf(args.name);
      if (!isTextual(mediaType)) return ok({ name: args.name, bytes, mediaType, readable: false });

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
