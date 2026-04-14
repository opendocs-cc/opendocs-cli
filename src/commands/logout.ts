import { Command } from "commander";
import { clearConfig } from "../lib/config.js";
import { createOutput } from "../lib/output.js";

export const logoutCommand = new Command("logout")
  .description("Clear stored credentials")
  .action((_opts, cmd) => {
    const globalOpts = cmd.optsWithGlobals();
    const out = createOutput(globalOpts.json);

    clearConfig();
    out.succeed("Logged out. Config removed.");
    out.result({ success: true });
  });
