import { Command } from "commander";
import { getConfigOrExit } from "../lib/config.js";
import { createApiClient } from "../lib/api.js";
import { createOutput, brand } from "../lib/output.js";
import { resolveDocRef } from "../lib/doc-ref.js";

function splitPeople(people: string[]) {
  const emails: string[] = [];
  const domains: string[] = [];
  for (const raw of people.flatMap((p) => p.split(","))) {
    const value = raw.trim().toLowerCase();
    if (!value) continue;
    if (value.startsWith("@")) domains.push(value.slice(1));
    else if (value.includes("@")) emails.push(value);
    else domains.push(value);
  }
  return { emails, domains };
}

export const shareCommand = new Command("share")
  .description(
    "Share a document with people outside the workspace. `opendocs share roadmap sam@acme.com @acme.com` — emails get a link; @domain lets everyone at that domain in.",
  )
  .argument("<doc>", "Post ID, slug, or a local .md file this folder published")
  .argument("[people...]", "Emails and/or @domains. Omit to list who it's shared with.")
  .option("--remove", "Stop sharing with these people/domains")
  .option("--no-notify", "Don't email the people you add")
  .action(async (ref: string, people: string[], opts, cmd) => {
    const globalOpts = cmd.optsWithGlobals();
    const out = createOutput(globalOpts.json);
    const config = getConfigOrExit(out);
    if (globalOpts.apiUrl) config.apiUrl = globalOpts.apiUrl;

    try {
      const client = createApiClient(config);
      const postId = resolveDocRef(ref);
      const scope = { workspaceId: config.workspaceId };
      const { emails, domains } = splitPeople(people);

      if (emails.length === 0 && domains.length === 0) {
        const shares = await client.getShares(postId, scope);
        if (shares.emails.length === 0 && shares.domains.length === 0) {
          out.info("Not shared with anyone outside the workspace.");
        } else {
          for (const email of shares.emails) out.info(`${brand.purple("•")} ${email}`);
          for (const domain of shares.domains) out.info(`${brand.purple("•")} everyone @${domain}`);
        }
        out.result(shares);
        return;
      }

      if (opts.remove) {
        const result = await client.removeShares(postId, { emails, domains }, scope);
        out.succeed(`Stopped sharing with ${[...emails, ...domains.map((d) => `@${d}`)].join(", ")}`);
        out.result(result);
        return;
      }

      const result = await client.addShares(postId, { emails, domains, notify: opts.notify }, scope);
      const who = [...emails, ...domains.map((d) => `everyone @${d}`)].join(", ");
      out.succeed(`Shared with ${who}`);
      out.info(`${brand.label("Link:")} ${brand.url(result.url)}`);
      if (result.notified.length > 0) {
        out.info(brand.muted(`Emailed ${result.notified.join(", ")}. They sign in with that address to read it.`));
      } else {
        out.info(brand.muted("They open the link and sign in with an email that matches."));
      }
      out.result(result);
    } catch (err: unknown) {
      out.error(err as { status?: number; code?: string; message: string });
    }
  });
