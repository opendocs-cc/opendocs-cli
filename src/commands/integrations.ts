import { Command } from "commander";
import { getConfigOrExit } from "../lib/config.js";
import { createApiClient, type Integration, type IntegrationsOverview } from "../lib/api.js";
import { createOutput, brand, type Output } from "../lib/output.js";
import { integrationError } from "../lib/integrations.js";

/**
 * `opendocs integrations` — what the active workspace has connected
 * (Google Drive for `opendocs save`, DocuSeal for `opendocs sign`), the
 * named Drive folders, and who may use them. Read-only: connecting and
 * naming folders happens in the dashboard (owners and admins).
 */

const REGION_LABELS: Record<string, string> = {
  com: "com (api.docuseal.com)",
  eu: "eu (api.docuseal.eu)",
  custom: "custom (self-hosted)",
};

function joinNames(names: string[]): string {
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

function statusText(i: Integration): string {
  if (i.status === "connected") return brand.success("connected");
  if (i.status === "error") return `${brand.error("needs attention")}${i.error ? `: ${i.error}` : ""}`;
  return brand.muted("not connected");
}

function printIntegration(out: Output, i: Integration) {
  const details = [
    i.account ? i.account : null,
    i.provider === "docuseal" && i.region ? `region ${REGION_LABELS[i.region] ?? i.region}` : null,
  ].filter(Boolean);
  out.info(`  ${brand.value(i.name.padEnd(13))} ${statusText(i)}${details.length ? ` · ${details.join(" · ")}` : ""}`);

  if (i.provider !== "google_drive" || i.status === "not_connected") return;
  const destinations = i.destinations ?? [];
  if (destinations.length === 0) {
    out.info(brand.muted("    No folders named yet. Owners and admins add them in the dashboard."));
    return;
  }
  out.info(brand.label(`    Folders (opendocs save <doc> --folder "<name>"):`));
  const width = Math.max(...destinations.map((d) => d.name.length));
  for (const d of destinations) {
    const where = [d.driveName, d.folderName].filter(Boolean).join(" › ");
    out.info(`      ${brand.purple("•")} ${d.name.padEnd(width)}${where ? `  ${brand.muted(where)}` : ""}`);
  }
}

function printOverview(out: Output, data: IntegrationsOverview) {
  out.info(brand.label(`Integrations for ${data.workspace.name} (${data.tier} plan, you're ${data.role === "owner" ? "the owner" : `${data.role === "admin" ? "an" : "a"} ${data.role}`}):`));
  for (const i of data.integrations) printIntegration(out, i);

  out.info("");
  out.info(
    `  ${brand.label("Who can use".padEnd(13))} ${
      data.settings.usableBy === "admins" ? "owners and admins only" : "every workspace member"
    }`,
  );
  out.info(
    `  ${brand.label("Signatures".padEnd(13))} ${
      data.settings.signatureConfirmation === "browser"
        ? "sent by a signed-in person from the browser (API keys can't send)"
        : "sent by the agent after the user confirms in chat"
    }`,
  );
  if (!data.canUse) {
    out.warn("Only owners and admins can save to Drive or request signatures in this workspace.");
  }

  const notConnected = data.integrations.filter((i) => i.status === "not_connected").map((i) => i.name);
  const broken = data.integrations.filter((i) => i.status === "error").map((i) => i.name);
  const todo = [
    notConnected.length ? `connect ${joinNames(notConnected)}` : null,
    broken.length ? `reconnect ${joinNames(broken)}` : null,
  ].filter(Boolean);

  if (todo.length === 0 && data.canManage) return;
  out.info("");
  if (data.canManage) {
    out.info(`To ${todo.join(" and ")}, open the dashboard:`);
  } else if (todo.length > 0) {
    out.info(`Ask a workspace owner or admin to ${todo.join(" and ")} in the dashboard:`);
  } else {
    out.info("Only workspace owners and admins can connect or change integrations, in the dashboard:");
  }
  out.info(brand.url(data.dashboardUrl));
}

export const integrationsCommand = new Command("integrations")
  .description("Show the workspace's Google Drive and DocuSeal connections, named Drive folders and settings")
  .action(async (_opts, cmd) => {
    const globalOpts = cmd.optsWithGlobals();
    const out = createOutput(globalOpts.json);
    const config = getConfigOrExit();
    if (globalOpts.apiUrl) config.apiUrl = globalOpts.apiUrl;
    if (!config.workspaceId) {
      out.error({ code: "no_workspace", message: 'No active workspace. Run "opendocs login" first.' });
      return;
    }

    try {
      out.spin("Fetching integrations...");
      const data = await createApiClient(config).getIntegrations(config.workspaceId);
      out.stopSpinner();
      printOverview(out, data);
      out.result(data);
    } catch (err) {
      out.error(integrationError(err));
    }
  });
