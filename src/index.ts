import { Command } from "commander";
import { loginCommand } from "./commands/login.js";
import { logoutCommand } from "./commands/logout.js";
import { whoamiCommand } from "./commands/whoami.js";
import { publishCommand } from "./commands/publish.js";
import { updateCommand } from "./commands/update.js";
import { unpublishCommand } from "./commands/unpublish.js";
import { listCommand } from "./commands/list.js";
import { getCommand } from "./commands/get.js";
import { pullCommand } from "./commands/pull.js";
import { exportCommand } from "./commands/export.js";
import { workspaceCommand } from "./commands/workspace.js";
import { CLI_VERSION } from "./lib/version.js";

const program = new Command();

program
  .name("opendocs")
  .description("Publish Markdown to OpenDocs")
  .version(CLI_VERSION)
  .option("--json", "Output results as JSON (for scripting and agents)", false)
  .option("--api-url <url>", "Override API base URL");

program.addCommand(loginCommand);
program.addCommand(logoutCommand);
program.addCommand(whoamiCommand);
program.addCommand(publishCommand);
program.addCommand(updateCommand);
program.addCommand(unpublishCommand);
program.addCommand(listCommand);
program.addCommand(getCommand);
program.addCommand(pullCommand);
program.addCommand(exportCommand);
program.addCommand(workspaceCommand);

program.parse();
