import { Command } from "commander";
import { loginCommand } from "./commands/login.js";
import { logoutCommand } from "./commands/logout.js";
import { whoamiCommand } from "./commands/whoami.js";
import { publishCommand } from "./commands/publish.js";
import { updateCommand } from "./commands/update.js";
import { unpublishCommand } from "./commands/unpublish.js";
import { visibilityCommand } from "./commands/visibility.js";
import { deleteCommand } from "./commands/delete.js";
import { listCommand } from "./commands/list.js";
import { getCommand } from "./commands/get.js";
import { pullCommand } from "./commands/pull.js";
import { exportCommand } from "./commands/export.js";
import { workspaceCommand } from "./commands/workspace.js";
import { projectCommand } from "./commands/project.js";
import { agentCommand } from "./commands/agent.js";
import { cloneCommand } from "./commands/clone.js";
import { statusCommand } from "./commands/status.js";
import { historyCommand, rollbackCommand } from "./commands/history.js";
import { moveCommand } from "./commands/move.js";
import { shareCommand } from "./commands/share.js";
import { inviteCommand } from "./commands/invite.js";
import { claimCommand } from "./commands/claim.js";
import { CLI_VERSION } from "./lib/version.js";
import { setClientName } from "./lib/client-id.js";

const program = new Command();

program
  .name("opendocs")
  .description("Publish Markdown to OpenDocs")
  .version(CLI_VERSION)
  .option("--json", "Output results as JSON (for scripting and agents)", false)
  .option("--api-url <url>", "Override API base URL")
  .option(
    "--client <name>",
    "Agent or tool running the CLI, shown on published versions (auto-detected for Claude Code, Cursor, Codex, Gemini)",
  )
  .hook("preAction", (thisCommand) => {
    setClientName(thisCommand.opts().client);
  });

program.addCommand(loginCommand);
program.addCommand(logoutCommand);
program.addCommand(whoamiCommand);
program.addCommand(publishCommand);
program.addCommand(updateCommand);
program.addCommand(unpublishCommand);
program.addCommand(visibilityCommand);
program.addCommand(deleteCommand);
program.addCommand(listCommand);
program.addCommand(getCommand);
program.addCommand(pullCommand);
program.addCommand(exportCommand);
program.addCommand(workspaceCommand);
program.addCommand(projectCommand);
program.addCommand(cloneCommand);
program.addCommand(statusCommand);
program.addCommand(historyCommand);
program.addCommand(rollbackCommand);
program.addCommand(moveCommand);
program.addCommand(shareCommand);
program.addCommand(inviteCommand);
program.addCommand(claimCommand);
program.addCommand(agentCommand);

program.parse();
