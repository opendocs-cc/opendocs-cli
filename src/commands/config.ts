import { Command } from "commander";
import { getConfigOrExit, saveConfig } from "../lib/config.js";
import { createOutput, brand } from "../lib/output.js";

const ORGANIZE_VALUES = ["ask", "auto", "off"] as const;

/**
 * User preferences agents should honor across sessions and tools. Today
 * that's `organize`: how proactively an agent sorts documents into
 * projects (see "Keeping documents organized" in SKILL.md).
 */
export const configCommand = new Command("config").description(
  "Read or change preferences agents follow (e.g. `opendocs config set organize auto`)",
);

configCommand
  .command("get")
  .description("Show preferences")
  .argument("[key]", "organize")
  .action((key: string | undefined, _opts, cmd) => {
    const out = createOutput(cmd.optsWithGlobals().json);
    const config = getConfigOrExit();
    const prefs = { organize: config.organize ?? "ask" };
    if (key && key !== "organize") {
      out.error({ code: "unknown_key", message: `Unknown preference "${key}". Available: organize` });
      return;
    }
    out.info(`${brand.label("organize:")} ${brand.value(prefs.organize)} ${brand.muted("(ask | auto | off)")}`);
    out.result(key ? { [key]: prefs.organize } : prefs);
  });

configCommand
  .command("set")
  .description("Change a preference")
  .argument("<key>", "organize")
  .argument("<value>", "ask | auto | off")
  .action((key: string, value: string, _opts, cmd) => {
    const out = createOutput(cmd.optsWithGlobals().json);
    const config = getConfigOrExit();
    if (key !== "organize") {
      out.error({ code: "unknown_key", message: `Unknown preference "${key}". Available: organize` });
      return;
    }
    if (!(ORGANIZE_VALUES as readonly string[]).includes(value)) {
      out.error({ code: "invalid_value", message: `organize must be one of: ${ORGANIZE_VALUES.join(", ")}` });
      return;
    }
    saveConfig({ ...config, organize: value as (typeof ORGANIZE_VALUES)[number] });
    const meaning: Record<string, string> = {
      ask: "agents suggest a new project when the topic changes and ask first",
      auto: "agents create and pick projects on their own and tell you where things went",
      off: "agents publish to the active project only",
    };
    out.succeed(`organize = ${brand.value(value)} — ${meaning[value]}`);
    out.result({ organize: value });
  });
