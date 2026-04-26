import { Command } from "commander";
import { getConfigOrExit, saveConfig, type CliConfig } from "../lib/config.js";
import { createApiClient } from "../lib/api.js";
import { createOutput, brand } from "../lib/output.js";

type Project = {
  id: string;
  workspaceId: string;
  name: string;
  slug: string;
  isDefault: boolean;
  postCount?: number;
};

function requireWorkspace(config: CliConfig) {
  if (!config.workspaceId) {
    throw new Error('No active workspace. Run "opendocs login" first.');
  }
  return config.workspaceId;
}

function setActiveProject(config: CliConfig, project: Project) {
  saveConfig({
    ...config,
    projectId: project.id,
    projectName: project.name,
    projectSlug: project.slug,
  });
}

async function resolveProject(client: ReturnType<typeof createApiClient>, workspaceId: string, ref: string) {
  const { projects } = await client.listProjects(workspaceId);
  return projects.find((p) => p.id === ref || p.slug === ref) ?? null;
}

export const projectCommand = new Command("project")
  .description("List, create, and switch between projects in the active workspace");

projectCommand
  .command("list")
  .alias("ls")
  .description("List projects in the active workspace")
  .action(async (_opts, cmd) => {
    const globalOpts = cmd.optsWithGlobals();
    const out = createOutput(globalOpts.json);
    const config = getConfigOrExit();
    if (globalOpts.apiUrl) config.apiUrl = globalOpts.apiUrl;

    try {
      const workspaceId = requireWorkspace(config);
      const client = createApiClient(config);
      out.spin("Fetching projects...");
      const { projects } = await client.listProjects(workspaceId);
      out.succeed(
        `${brand.purpleBold(String(projects.length))} project${projects.length === 1 ? "" : "s"}`,
      );
      const header = `  ${pad("Active", 8)} ${pad("Name", 28)} ${pad("Slug", 22)} ${pad("Docs", 6)}`;
      out.info(brand.label(header));
      out.info(brand.label("  " + "\u2500".repeat(68)));
      for (const project of projects) {
        const active = project.id === config.projectId;
        out.info(
          `  ${active ? brand.success(pad("✔", 8)) : pad("", 8)} ${
            active ? brand.purpleBold(pad(project.name, 28)) : brand.value(pad(project.name, 28))
          } ${brand.muted(pad(project.slug, 22))} ${brand.muted(pad(String(project.postCount ?? 0), 6))}`,
        );
      }
      out.result({ projects, activeProjectId: config.projectId ?? null });
    } catch (err: unknown) {
      out.error(err as { status?: number; code?: string; message: string });
    }
  });

projectCommand
  .command("current")
  .description("Show the active project")
  .action(async (_opts, cmd) => {
    const globalOpts = cmd.optsWithGlobals();
    const out = createOutput(globalOpts.json);
    const config = getConfigOrExit();
    if (globalOpts.apiUrl) config.apiUrl = globalOpts.apiUrl;

    if (!config.projectId || !config.projectSlug || !config.projectName) {
      out.error({
        code: "no_project",
        message: 'No active project. Run "opendocs project use default".',
      });
      return;
    }
    out.succeed(`Active project: ${brand.purpleBold(config.projectName)} ${brand.muted(`(${config.projectSlug})`)}`);
    out.result({
      projectId: config.projectId,
      projectName: config.projectName,
      projectSlug: config.projectSlug,
    });
  });

projectCommand
  .command("create <name>")
  .description("Create a project in the active workspace")
  .option("--slug <slug>", "Custom project slug")
  .option("--use", "Switch to the new project after creating it")
  .action(async (name: string, opts, cmd) => {
    const globalOpts = cmd.optsWithGlobals();
    const out = createOutput(globalOpts.json);
    const config = getConfigOrExit();
    if (globalOpts.apiUrl) config.apiUrl = globalOpts.apiUrl;

    try {
      const workspaceId = requireWorkspace(config);
      const client = createApiClient(config);
      out.spin(`Creating project ${brand.value(name)}...`);
      const { project } = await client.createProject({
        workspaceId,
        name,
        slug: opts.slug,
      });
      if (opts.use) setActiveProject(config, project);
      out.succeed(
        `Created ${brand.purpleBold(project.name)} ${brand.muted(`(${project.slug})`)}`,
      );
      if (opts.use) out.info(`Active project is now ${brand.value(project.name)}.`);
      out.result({ project, active: Boolean(opts.use) });
    } catch (err: unknown) {
      out.error(err as { status?: number; code?: string; message: string });
    }
  });

projectCommand
  .command("use <slugOrId>")
  .alias("switch")
  .description("Switch the CLI's active project")
  .action(async (slugOrId: string, _opts, cmd) => {
    const globalOpts = cmd.optsWithGlobals();
    const out = createOutput(globalOpts.json);
    const config = getConfigOrExit();
    if (globalOpts.apiUrl) config.apiUrl = globalOpts.apiUrl;

    try {
      const workspaceId = requireWorkspace(config);
      const client = createApiClient(config);
      out.spin(`Looking up project ${brand.value(slugOrId)}...`);
      const project = await resolveProject(client, workspaceId, slugOrId);
      if (!project) {
        out.stopSpinner();
        out.error({
          code: "not_found",
          message: `Project "${slugOrId}" was not found in the active workspace.`,
        });
        return;
      }
      setActiveProject(config, project);
      out.succeed(
        `Switched to ${brand.purpleBold(project.name)} ${brand.muted(`(${project.slug})`)}`,
      );
      out.result({ success: true, project });
    } catch (err: unknown) {
      out.error(err as { status?: number; code?: string; message: string });
    }
  });

projectCommand
  .command("rename <slugOrId>")
  .description("Rename a project or change its slug")
  .requiredOption("--name <name>", "New project name")
  .option("--slug <slug>", "New project slug")
  .action(async (slugOrId: string, opts, cmd) => {
    const globalOpts = cmd.optsWithGlobals();
    const out = createOutput(globalOpts.json);
    const config = getConfigOrExit();
    if (globalOpts.apiUrl) config.apiUrl = globalOpts.apiUrl;

    try {
      const workspaceId = requireWorkspace(config);
      const client = createApiClient(config);
      const existing = await resolveProject(client, workspaceId, slugOrId);
      if (!existing) {
        out.error({ code: "not_found", message: `Project "${slugOrId}" was not found.` });
        return;
      }
      out.spin(`Updating ${brand.value(existing.name)}...`);
      const { project } = await client.renameProject(existing.id, {
        name: opts.name,
        slug: opts.slug,
      });
      if (config.projectId === project.id) setActiveProject(config, project);
      out.succeed(`Updated ${brand.purpleBold(project.name)} ${brand.muted(`(${project.slug})`)}`);
      out.result({ project });
    } catch (err: unknown) {
      out.error(err as { status?: number; code?: string; message: string });
    }
  });

projectCommand
  .command("delete <slugOrId>")
  .description("Delete an empty non-default project")
  .option("--yes", "Confirm deletion")
  .action(async (slugOrId: string, opts, cmd) => {
    const globalOpts = cmd.optsWithGlobals();
    const out = createOutput(globalOpts.json);
    const config = getConfigOrExit();
    if (globalOpts.apiUrl) config.apiUrl = globalOpts.apiUrl;

    if (!opts.yes) {
      out.error({
        code: "confirmation_required",
        message: "Project deletion requires --yes.",
      });
      return;
    }

    try {
      const workspaceId = requireWorkspace(config);
      const client = createApiClient(config);
      const project = await resolveProject(client, workspaceId, slugOrId);
      if (!project) {
        out.error({ code: "not_found", message: `Project "${slugOrId}" was not found.` });
        return;
      }
      out.spin(`Deleting ${brand.value(project.name)}...`);
      const result = await client.deleteProject(project.id);
      if (config.projectId === project.id) {
        const { project: defaultProject } = await client.defaultProject(workspaceId);
        setActiveProject(config, defaultProject);
      }
      out.succeed(`Deleted project ${brand.value(project.name)}`);
      out.result(result);
    } catch (err: unknown) {
      out.error(err as { status?: number; code?: string; message: string });
    }
  });

function pad(str: string, len: number): string {
  if (str.length > len) return str.slice(0, len - 1) + "…";
  return str.padEnd(len);
}

