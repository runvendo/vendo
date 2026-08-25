/**
 * One file argument, resolved against the script's own cwd and read as bytes.
 *
 * The diagnostics are POSIX-shaped because bash PRINTS them: a parser that
 * invented its own sentence would be the one command in the shell that does not
 * sound like the shell.
 */
import type { ExecResult, ResolvedCommandContext } from "just-bash";

export type Input = { bytes: Uint8Array } | { refusal: ExecResult };

export async function inputBytes(
  name: string,
  args: string[],
  ctx: ResolvedCommandContext,
): Promise<Input> {
  const target = args[0];
  if (target === undefined || target.startsWith("-")) {
    return { refusal: { stdout: "", stderr: `usage: ${name} <file>\n`, exitCode: 2 } };
  }
  try {
    return { bytes: await ctx.fs.readFileBuffer(ctx.fs.resolvePath(ctx.cwd, target)) };
  } catch (cause) {
    // A directory is the one failure bash names differently, and the difference
    // matters: told "no such file" an agent invents another path, told "is a
    // directory" it lists it. Both filesystems carry the code in the MESSAGE and
    // set no `code` property (`enoent`/`eisdir` in store's workspace-fs.ts).
    const reason = cause instanceof Error && cause.message.startsWith("EISDIR")
      ? "Is a directory"
      : "No such file or directory";
    return { refusal: { stdout: "", stderr: `${name}: ${target}: ${reason}\n`, exitCode: 1 } };
  }
}

/** What a parser says when the bytes are not the format it was handed. The
    message names the format rather than echoing a library's internal error,
    because the agent's next move is to tell the user what the file actually is. */
export const notThisFormat = (name: string, target: string, format: string, cause: unknown): ExecResult => ({
  stdout: "",
  stderr: `${name}: ${target}: not a readable ${format} (${cause instanceof Error ? cause.message : String(cause)})\n`,
  exitCode: 1,
});
