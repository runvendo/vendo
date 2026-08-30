export function option(args: string[], name: string): string | undefined {
  const exact = args.indexOf(name);
  if (exact >= 0) return args[exact + 1];
  return args.find((value) => value.startsWith(`${name}=`))?.slice(name.length + 1);
}

export function options(args: string[], name: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index]!;
    if (value === name) {
      const next = args[index + 1];
      if (next === undefined || next.startsWith("--")) throw new Error(`${name} requires a value`);
      values.push(next);
      index += 1;
    } else if (value.startsWith(`${name}=`)) {
      values.push(value.slice(name.length + 1));
    }
  }
  return values;
}

export function positionals(args: string[], optionNames: string[]): string[] {
  const values = new Set<string>();
  for (const name of optionNames) {
    const index = args.indexOf(name);
    if (index >= 0 && args[index + 1] !== undefined) values.add(args[index + 1]!);
  }
  return args.filter((value) => !value.startsWith("--") && !values.has(value));
}
