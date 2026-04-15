// Single source of truth for the CLI version. Everything that needs to know
// the version — commander's --version flag, the User-Agent sent to the API —
// imports CLI_VERSION from here. The string comes from package.json so a
// `npm version` bump is all it takes; we can't have the two drift and ship
// a 0.1.3 tarball that calls itself 0.1.2 again.
import pkg from "../../package.json" with { type: "json" };

export const CLI_VERSION: string = pkg.version;
