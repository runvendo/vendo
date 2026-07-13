export function option(args: string[], name: string): string | undefined {
  const exact = args.indexOf(name);
  if (exact >= 0) return args[exact + 1];
  return args.find((value) => value.startsWith(`${name}=`))?.slice(name.length + 1);
}

export function positionals(args: string[], optionNames: string[]): string[] {
  const values = new Set<string>();
  for (const name of optionNames) {
    const index = args.indexOf(name);
    if (index >= 0 && args[index + 1] !== undefined) values.add(args[index + 1]!);
  }
  return args.filter((value) => !value.startsWith("--") && !values.has(value));
}
