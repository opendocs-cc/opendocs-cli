import { Command } from "commander";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { getConfigOrExit, type CliConfig } from "../lib/config.js";
import {
  createApiClient,
  type CreateSignatureRequestBody,
  type SignatureDocumentKind,
  type SignatureRequest,
  type SignatureRequestStatus,
} from "../lib/api.js";
import { createOutput, brand, type Output } from "../lib/output.js";
import { resolveDocRef } from "../lib/doc-ref.js";
import { parseSigners, SignerParseError } from "../lib/signers.js";
import {
  integrationError,
  printChecksum,
  printNextStep,
  printSignatureSummary,
} from "../lib/integrations.js";
import { parseVersionNumber } from "./save.js";
import { safeServerFilename, singleExportPath } from "./export.js";

/**
 * `opendocs sign …` — e-signatures through the workspace's DocuSeal
 * connection.
 *
 *   request   create a DRAFT (nothing is emailed) and print a summary
 *   send      send a draft; needs --yes outside a terminal
 *   status · list · cancel · save
 *   download  signed PDF, signing certificate, or a draft's exact PDF
 *
 * Drafting and sending are separate steps on purpose: the agent reads the
 * signers back to its user and only sends after an explicit yes. In
 * workspaces set to browser confirmation, API keys can't send at all and
 * the user clicks Send on the approve URL instead.
 */

const STATUSES: SignatureRequestStatus[] = [
  "draft",
  "pending",
  "completed",
  "declined",
  "expired",
  "cancelled",
  "failed",
];

const DOCUMENT_KINDS: SignatureDocumentKind[] = ["signed", "audit", "draft"];

const DOCUMENT_LABELS: Record<SignatureDocumentKind, string> = {
  signed: "signed PDF",
  audit: "signing certificate",
  draft: "draft PDF",
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function setup(cmd: Command) {
  const globalOpts = cmd.optsWithGlobals();
  const json = Boolean(globalOpts.json);
  const out = createOutput(json);
  const config = getConfigOrExit();
  if (globalOpts.apiUrl) config.apiUrl = globalOpts.apiUrl;
  return { out, json, config, client: createApiClient(config) };
}

function requireWorkspace(out: Output, config: CliConfig): string | null {
  if (!config.workspaceId) {
    out.error({ code: "no_workspace", message: 'No active workspace. Run "opendocs login" first.' });
    return null;
  }
  return config.workspaceId;
}

/**
 * Prompting is only possible for a human at a terminal. `--json` counts as
 * non-interactive too: the summary a person must see before saying yes
 * isn't printed in JSON mode.
 */
function canPrompt(json: boolean): boolean {
  return !json && Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

async function askYesNo(question: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise<string>((resolve) => {
    rl.question(`${question} [y/N] `, resolve);
    rl.once("close", () => resolve(""));
  });
  rl.close();
  return /^y(es)?$/i.test(answer.trim());
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function isValidDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

function signedCount(req: SignatureRequest): string {
  const done = req.signers.filter((s) => s.status === "completed").length;
  return `${done} of ${req.signers.length} signed`;
}

export const signCommand = new Command("sign").description(
  "Send documents for e-signature (DocuSeal): request a draft, confirm with the user, then send",
);

// ── request ───────────────────────────────────────────────────────────────

signCommand
  .command("request")
  .description(
    'Create a draft signature request (nothing is sent): `opendocs sign request offer.md --signer "Employee=John Adams <adams@company.com>"`',
  )
  .argument("<doc>", "Post ID, slug, or a local .md file this folder published")
  .option(
    "--signer <signer>",
    'Signer as "Name <email>" or "Role=Name <email>" (repeat for each signer, in signing order)',
    collect,
    [] as string[],
  )
  .option("--parallel", "Email every signer at once (default: one after another, in order)")
  .option("--subject <subject>", "Email subject")
  .option("--message <message>", "Email message")
  .option("--expires <date>", "Expiry date, YYYY-MM-DD")
  .option("--file-to <folder>", "Drive folder to file the signed PDF and certificate in when everyone has signed")
  .option("--version <n>", "Send an earlier version of the document (default: latest)")
  .action(async (ref: string, opts, cmd) => {
    const { out, config, client } = setup(cmd);
    const workspaceId = requireWorkspace(out, config);
    if (!workspaceId) return;

    let body: CreateSignatureRequestBody;
    try {
      body = {
        workspaceId,
        signers: parseSigners(opts.signer as string[]),
        order: opts.parallel ? "parallel" : "sequential",
      };
    } catch (err) {
      if (err instanceof SignerParseError) {
        out.error({ code: err.code, message: err.message });
        return;
      }
      throw err;
    }

    if (opts.subject !== undefined || opts.message !== undefined) {
      body.message = {
        ...(opts.subject !== undefined ? { subject: String(opts.subject) } : {}),
        ...(opts.message !== undefined ? { body: String(opts.message) } : {}),
      };
    }
    if (opts.expires !== undefined) {
      const expires = String(opts.expires).trim();
      if (!isValidDate(expires)) {
        out.error({ code: "invalid_date", message: `Invalid --expires: ${opts.expires}. Use a date like 2026-11-30.` });
        return;
      }
      body.expiresAt = expires;
    }
    if (opts.fileTo !== undefined) {
      const folder = String(opts.fileTo).trim();
      if (!folder) {
        out.error({ code: "missing_folder", message: "Pass --file-to with a folder name from `opendocs integrations`." });
        return;
      }
      body.fileTo = folder;
    }
    if (opts.version !== undefined) {
      const n = parseVersionNumber(opts.version);
      if (n === null) {
        out.error({ code: "invalid_version", message: `Invalid --version: ${opts.version}. Use a version number like 3 (see \`opendocs history\`).` });
        return;
      }
      body.versionNumber = n;
    }

    try {
      out.spin("Preparing the document for signing...");
      const req = await client.createSignatureRequest(resolveDocRef(ref), body);
      out.succeed("Draft signature request created. Nothing has been sent yet.");
      out.info("");
      printSignatureSummary(out, req);
      printNextStep(out, req);
      out.result(req);
    } catch (err) {
      out.error(integrationError(err));
    }
  });

// ── send ──────────────────────────────────────────────────────────────────

signCommand
  .command("send")
  .description("Send a draft signature request to its signers (needs --yes outside a terminal)")
  .argument("<id>", "Signature request ID from `opendocs sign request`")
  .option("-y, --yes", "Confirm that the user approved these signers. Required when not running in a terminal.")
  .action(async (id: string, opts, cmd) => {
    const { out, json, config, client } = setup(cmd);

    // The gate runs before any network call: an agent can't send by accident.
    if (!opts.yes && !canPrompt(json)) {
      out.error({
        code: "confirm_required",
        message: `Refusing to send without confirmation. Read every signer and email back to the user, get an explicit yes, then run: opendocs sign send ${id} --yes`,
      });
      return;
    }

    const workspaceId = requireWorkspace(out, config);
    if (!workspaceId) return;

    try {
      if (!opts.yes) {
        out.spin("Fetching the signature request...");
        const draft = await client.getSignatureRequest(id, { workspaceId });
        out.stopSpinner();
        if (draft.status !== "draft") {
          out.error({
            code: "already_sent",
            message: `This request is no longer a draft (status: ${draft.status}).`,
            extra: { status: draft.status },
            hint: `See where it stands: opendocs sign status ${id}`,
          });
          return;
        }
        printSignatureSummary(out, draft);
        if (draft.confirmation.mode === "browser") {
          printNextStep(out, draft);
          return;
        }
        out.info("");
        if (!(await askYesNo("Send this for signature now?"))) {
          out.info(brand.muted("Cancelled. Nothing was sent."));
          return;
        }
      }

      out.spin("Sending for signature...");
      const req = await client.sendSignatureRequest(id, { workspaceId });
      out.succeed(
        `Sent ${brand.value(req.document.title)} ${brand.muted(`(v${req.document.versionNumber})`)} for signature`,
      );
      out.info("");
      printSignatureSummary(out, req, { withStatus: true });
      printNextStep(out, req);
      out.result(req);
    } catch (err) {
      out.error(integrationError(err, { requestId: id }));
    }
  });

// ── status ────────────────────────────────────────────────────────────────

signCommand
  .command("status")
  .description("Show where a signature request stands (refreshed from DocuSeal)")
  .argument("<id>", "Signature request ID")
  .action(async (id: string, _opts, cmd) => {
    const { out, config, client } = setup(cmd);
    const workspaceId = requireWorkspace(out, config);
    if (!workspaceId) return;
    try {
      out.spin("Fetching the signature request...");
      const req = await client.getSignatureRequest(id, { workspaceId });
      out.stopSpinner();
      printSignatureSummary(out, req, { withStatus: true });
      printNextStep(out, req);
      out.result(req);
    } catch (err) {
      out.error(integrationError(err, { requestId: id }));
    }
  });

// ── list ──────────────────────────────────────────────────────────────────

signCommand
  .command("list")
  .alias("ls")
  .description("List signature requests in the workspace, newest first (max 50)")
  .option("--doc <doc>", "Only requests for this document (ID, slug or published .md file)")
  .option("--status <status>", `Only requests with this status: ${STATUSES.join(", ")}`)
  .action(async (opts, cmd) => {
    const { out, config, client } = setup(cmd);
    const workspaceId = requireWorkspace(out, config);
    if (!workspaceId) return;

    let status: SignatureRequestStatus | undefined;
    if (opts.status !== undefined) {
      status = String(opts.status).toLowerCase() as SignatureRequestStatus;
      if (!STATUSES.includes(status)) {
        out.error({ code: "invalid_status", message: `Invalid --status: ${opts.status}. Use one of: ${STATUSES.join(", ")}.` });
        return;
      }
    }

    try {
      out.spin("Fetching signature requests...");
      let postId: string | undefined;
      if (opts.doc !== undefined) {
        // The list filter takes a post ID; resolve slugs the same way
        // every other `<doc>` argument works.
        postId = resolveDocRef(String(opts.doc));
        if (!UUID_RE.test(postId)) {
          postId = (await client.getPost(postId, { workspaceId })).post.id;
        }
      }
      const { requests } = await client.listSignatureRequests({ workspaceId, postId, status });
      out.stopSpinner();
      if (requests.length === 0) {
        out.info("No signature requests.");
      } else {
        out.info(brand.label(`Signature requests (${requests.length}):`));
        for (const r of requests) {
          out.info(
            `  ${r.id}  ${r.status.padEnd(9)}  ${brand.value(r.document.title)} ${brand.muted(`v${r.document.versionNumber}`)}  ${signedCount(r)}  ${brand.muted((r.createdAt ?? "").slice(0, 10))}`,
          );
        }
        out.info(brand.muted("  Details: opendocs sign status <id>"));
      }
      out.result({ requests });
    } catch (err) {
      out.error(integrationError(err));
    }
  });

// ── cancel ────────────────────────────────────────────────────────────────

signCommand
  .command("cancel")
  .description("Cancel a draft or pending signature request (needs --yes outside a terminal)")
  .argument("<id>", "Signature request ID")
  .option("-y, --yes", "Confirm the cancellation. Required when not running in a terminal.")
  .action(async (id: string, opts, cmd) => {
    const { out, json, config, client } = setup(cmd);

    if (!opts.yes) {
      if (!canPrompt(json)) {
        out.error({
          code: "confirm_required",
          message: `Refusing to cancel without confirmation. Ask the user, then run: opendocs sign cancel ${id} --yes`,
        });
        return;
      }
      if (!(await askYesNo(`Cancel signature request ${id}? Signers will no longer be able to sign.`))) {
        out.info(brand.muted("Kept. Nothing was cancelled."));
        return;
      }
    }

    const workspaceId = requireWorkspace(out, config);
    if (!workspaceId) return;
    try {
      out.spin("Cancelling...");
      const req = await client.cancelSignatureRequest(id, { workspaceId });
      out.succeed(`Cancelled the signature request for ${brand.value(req.document.title)} ${brand.muted(`(${id})`)}`);
      out.result(req);
    } catch (err) {
      out.error(integrationError(err, { requestId: id }));
    }
  });

// ── download ──────────────────────────────────────────────────────────────

signCommand
  .command("download")
  .description(
    "Download the signed PDF of a completed request, its signing certificate (--audit), or a draft's exact PDF before sending (--kind draft)",
  )
  .argument("<id>", "Signature request ID")
  .option("--kind <kind>", `Which PDF: ${DOCUMENT_KINDS.join(", ")}`, "signed")
  .option("--draft", "Same as --kind draft: the exact PDF signers will get (drafts only)")
  .option("--audit", "Same as --kind audit: the signing certificate / audit log")
  .option("-o, --output <path>", "Output file or directory (default: the server's filename in the current folder)")
  .action(async (id: string, opts, cmd) => {
    const { out, config, client } = setup(cmd);

    const requested = new Set<string>();
    // --kind defaults to "signed"; only an explicit --kind counts against --draft/--audit.
    if (cmd.getOptionValueSource("kind") === "cli") requested.add(String(opts.kind).toLowerCase());
    if (opts.draft) requested.add("draft");
    if (opts.audit) requested.add("audit");
    if (requested.size > 1) {
      out.error({ code: "conflicting_options", message: "Pick one of --kind, --draft or --audit." });
      return;
    }
    const kind = ([...requested][0] ?? "signed") as SignatureDocumentKind;
    if (!DOCUMENT_KINDS.includes(kind)) {
      out.error({ code: "invalid_kind", message: `Invalid --kind: ${opts.kind}. Use one of: ${DOCUMENT_KINDS.join(", ")}.` });
      return;
    }

    const workspaceId = requireWorkspace(out, config);
    if (!workspaceId) return;
    try {
      out.spin(`Downloading the ${DOCUMENT_LABELS[kind]}...`);
      const { buffer, filename } = await client.downloadSignatureDocument(id, kind, { workspaceId });
      const name =
        (filename && safeServerFilename(filename)) ?? `signature-${id}-${kind}.pdf`;
      const outPath = singleExportPath(opts.output, name);
      fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
      fs.writeFileSync(outPath, buffer);
      out.succeed(`Downloaded the ${DOCUMENT_LABELS[kind]} ${brand.value(path.basename(outPath))}`);
      out.info(`${brand.label("Saved to:")} ${brand.purple(outPath)}`);
      out.result({ id, kind, filename: outPath, bytes: buffer.length });
    } catch (err) {
      out.error(integrationError(err, { requestId: id }));
    }
  });

// ── save ──────────────────────────────────────────────────────────────────

signCommand
  .command("save")
  .description('Save the signed PDF and signing certificate to a named Drive folder: `opendocs sign save <id> --folder "Signed agreements"`')
  .argument("<id>", "Signature request ID")
  .requiredOption("--folder <name>", "Drive folder name the workspace set up (see `opendocs integrations`)")
  .action(async (id: string, opts, cmd) => {
    const { out, config, client } = setup(cmd);
    const workspaceId = requireWorkspace(out, config);
    if (!workspaceId) return;
    const folder = String(opts.folder).trim();
    if (!folder) {
      out.error({ code: "missing_folder", message: "Pass --folder with a folder name from `opendocs integrations`." });
      return;
    }
    try {
      out.spin(`Saving to ${brand.value(folder)}...`);
      const result = await client.saveSignatureRequestToStorage(id, { destination: folder, workspaceId });
      out.succeed(
        `Saved ${result.files.length} file${result.files.length === 1 ? "" : "s"} to ${brand.value(result.destination.name)}`,
      );
      for (const f of result.files) {
        out.info("");
        out.info(`${brand.value(f.name)} ${brand.muted(f.kind === "audit" ? "(signing certificate)" : "(signed PDF)")}`);
        out.info(brand.url(f.url));
        printChecksum(out, f);
      }
      out.result(result);
    } catch (err) {
      out.error(integrationError(err, { requestId: id }));
    }
  });
