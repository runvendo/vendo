#!/usr/bin/env node
import { runCli } from "../dist/cli.js";

// `runCli` reads the job from stdin to EOF — with no piped input and a real
// terminal attached, that read never resolves. Fail fast instead of hanging
// forever. Kept here (not in runCli) so runCli stays pure/testable: its
// tests drive stdin with an in-memory Readable that has no `isTTY`.
if (process.stdin.isTTY) {
  process.stderr.write(
    "vendo-engine: expects a job JSON on stdin, e.g. `echo '{\"instructions\":...,\"root\":...}' | vendo-engine`. No interactive terminal input is supported.\n",
  );
  process.exit(1);
}

process.exitCode = await runCli(process.argv.slice(2), {
  stdin: process.stdin,
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
});
