import type { CliConfig } from "./config.js";
import type { createApiClient } from "./api.js";
import { stateKey, type StateFile } from "./state.js";

type Client = ReturnType<typeof createApiClient>;

export type ProjectTarget = {
  id?: string;
  slug: string;
  name: string;
  /**
   * Why this project: an explicit --project flag, the file's place in a
   * cloned workspace (projects/<slug>/...), the folder's linked project
   * (`opendocs project link`), or the CLI's active project.
   */
  source: "flag" | "path" | "folder" | "active";
};

/**
 * Where each new (untracked) file should be published, like git deciding
 * the branch from where you are: --project wins, then a file's
 * projects/<slug>/ location inside a clone, then the folder link, then the
 * globally active project.
 */
export async function resolveProjectTargets(args: {
  client: Client;
  config: CliConfig;
  root: string;
  state: StateFile;
  files: string[];
  flagProject: { id: string; slug: string; name: string } | null;
}): Promise<Map<string, ProjectTarget>> {
  const { client, config, root, state, files, flagProject } = args;
  const targets = new Map<string, ProjectTarget>();
  const sameWorkspace = !state.workspaceId || state.workspaceId === config.workspaceId;
  const active: ProjectTarget = {
    id: config.projectId,
    slug: config.projectSlug ?? "default",
    name: config.projectName ?? "Default",
    source: "active",
  };

  let projects: Awaited<ReturnType<Client["listProjects"]>>["projects"] | null = null;
  for (const file of files) {
    if (flagProject) {
      targets.set(file, { ...flagProject, source: "flag" });
      continue;
    }
    const pathSlug = sameWorkspace ? stateKey(root, file).match(/^projects\/([^/]+)\//)?.[1] : undefined;
    if (pathSlug && config.workspaceId) {
      projects ??= (await client.listProjects(config.workspaceId)).projects;
      const match = projects.find((p) => p.slug === pathSlug);
      if (match) {
        targets.set(file, { id: match.id, slug: match.slug, name: match.name, source: "path" });
        continue;
      }
    }
    if (state.project && sameWorkspace) {
      targets.set(file, { ...state.project, source: "folder" });
      continue;
    }
    targets.set(file, active);
  }
  return targets;
}

export function describeTarget(target: ProjectTarget): string {
  const why = {
    flag: "--project",
    path: "from the folder path",
    folder: "linked to this folder",
    active: "active project",
  }[target.source];
  return `${target.name} (${why})`;
}
