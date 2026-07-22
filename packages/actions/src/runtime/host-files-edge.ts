/** Edge build of the registry's filesystem leg (`#actions/host-files`):
 *  there is no disk on Web-standard runtimes, so every optional host config
 *  file reads as absent and the registry composes from inline config alone.
 *  Keep this module free of node builtins; the portability gate bundles it. */
export function readOptionalVendoJson<T>(
  _dir: string,
  _file: string,
  _parse: (value: unknown) => T,
): Promise<T | undefined> {
  return Promise.resolve(undefined);
}
