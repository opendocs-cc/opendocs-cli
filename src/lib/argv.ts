// `opendocs pull <doc> --version 2` asks for an earlier version of a
// document, but commander lets the root `--version` flag (print the CLI
// version) claim `--version` wherever it appears on the line. The root flag
// never takes a value, so a `--version` followed by a version number belongs
// to the subcommand. Rewriting it as `--version=2` gets it there: commander
// only matches the `=` form against options that take a value.
//
// Positional options would fix this too, but they'd stop global flags like
// `--json` working after the subcommand (`opendocs list --json`).
export function routeVersionOption(argv: string[]): string[] {
  const routed: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const next = argv[i + 1];
    if (argv[i] === "--version" && next !== undefined && /^v?\d+$/i.test(next)) {
      routed.push(`--version=${next}`);
      i++;
    } else {
      routed.push(argv[i]);
    }
  }
  return routed;
}
