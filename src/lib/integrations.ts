import { ApiError, type SignatureRequest, type SignerStatus, type StoredFile } from "./api.js";
import { brand, type Output, type OutputError } from "./output.js";
import { formatSigner } from "./signers.js";

/**
 * Shared pieces of `opendocs integrations`, `opendocs save` and
 * `opendocs sign …`: error hints, checksum lines and the signature-request
 * summary an agent reads back to its user before sending.
 */

export const BILLING_URL = "https://opendocs.cc/dashboard/billing";

const PROVIDER_NAMES: Record<string, string> = {
  google_drive: "Google Drive",
  docuseal: "DocuSeal",
};

export function providerName(provider: unknown): string {
  return typeof provider === "string" ? (PROVIDER_NAMES[provider] ?? provider) : "The integration";
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

/**
 * Adds a "what to do next" hint (human mode) and the useful extra fields
 * (`--json`) to errors from the integration endpoints. Anything else is
 * passed through unchanged.
 */
export function integrationError(err: unknown, ctx: { requestId?: string } = {}): OutputError {
  if (!(err instanceof ApiError)) return err as OutputError;
  const d = err.details ?? {};
  const base: OutputError = { status: err.status, code: err.code, message: err.message };
  const statusCmd = ctx.requestId ? `opendocs sign status ${ctx.requestId}` : "opendocs sign status <id>";

  switch (err.code) {
    case "plan_required":
      return { ...base, hint: `Integrations need a Pro or Team plan: ${BILLING_URL}` };

    case "integration_not_connected": {
      const name = providerName(d.provider);
      return {
        ...base,
        extra: { provider: d.provider },
        hint: `${name} isn't connected to this workspace. An owner or admin can connect it in the dashboard; \`opendocs integrations\` shows the link.`,
      };
    }

    case "reconnect_required":
      return {
        ...base,
        hint: "Google Drive access expired or was revoked. An owner or admin needs to reconnect it in the dashboard; `opendocs integrations` shows the link.",
      };

    case "destination_not_found": {
      const names = stringList(d.destinations);
      return {
        ...base,
        extra: { destinations: names },
        hint:
          names.length > 0
            ? `Available folders:\n${names.map((n) => `  • ${n}`).join("\n")}`
            : "No Drive folders are set up yet. An owner or admin can add one in the dashboard; `opendocs integrations` shows the link.",
      };
    }

    case "approval_required": {
      const approveUrl = typeof d.approveUrl === "string" ? d.approveUrl : undefined;
      return {
        ...base,
        extra: { approveUrl },
        hint: approveUrl
          ? `This workspace sends signature requests from the browser. Ask the user to open this link and click Send:\n  ${approveUrl}`
          : "This workspace sends signature requests from the browser. Ask the user to send it from the dashboard.",
      };
    }

    case "signer_roles_mismatch": {
      const roles = stringList(d.roles);
      return {
        ...base,
        extra: { roles },
        hint:
          roles.length > 0
            ? `The document's signature block has these roles:\n${roles.map((r) => `  • ${r}`).join("\n")}\nGive each role exactly one signer, e.g. --signer "${roles[0]}=Name <email>". Ask the user who signs for each role.`
            : undefined,
      };
    }

    case "already_sent":
      return { ...base, extra: { status: d.status }, hint: `See where it stands: ${statusCmd}` };

    case "not_completed":
      return { ...base, hint: `Not everyone has signed yet. Check progress: ${statusCmd}` };

    case "not_available":
      return {
        ...base,
        hint: `The draft PDF only exists until the request is sent. For a sent request, download the signed PDF once everyone has signed; ${statusCmd} shows where it stands.`,
      };

    default:
      return base;
  }
}

export function shortSha(sha: string | null | undefined): string {
  return sha ? sha.slice(0, 12) : "unknown";
}

/** SHA-256 + whether Google's own checksum matched what OpenDocs uploaded. */
export function printChecksum(out: Output, file: Pick<StoredFile, "sha256" | "driveSha256" | "verified">) {
  out.info(`${brand.label("SHA-256:")} ${file.sha256}`);
  if (file.verified) {
    out.info(`${brand.success("✔")} Google Drive's checksum matches.`);
  } else if (!file.driveSha256) {
    out.warn("Google Drive didn't report a checksum, so the upload couldn't be verified.");
  } else {
    out.warn(`Google Drive's checksum doesn't match (${file.driveSha256}). Check the file in Drive.`);
  }
}

const SIGNER_STATUS_LABELS: Record<SignerStatus, string> = {
  draft: "not sent",
  awaiting: "waiting for the previous signer",
  sent: "email sent",
  opened: "opened",
  completed: "signed",
  declined: "declined",
};

function dateOnly(value: string | null | undefined): string | null {
  if (!value) return null;
  return /^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(0, 10) : value;
}

function timestamp(value: string | null | undefined): string | null {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return `${d.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

function orderLine(order: SignatureRequest["order"]): string {
  return order === "parallel"
    ? "parallel: everyone is emailed at once"
    : "sequential: each signer is emailed after the previous one has signed";
}

/**
 * The block an agent reads back to its user: document, version and short
 * hash, signers in order, email text, expiry, auto-filing and warnings.
 * `withStatus` adds the request and per-signer status (for `sign status`).
 */
export function printSignatureSummary(
  out: Output,
  req: SignatureRequest,
  opts: { withStatus?: boolean } = {},
) {
  const label = (s: string) => brand.label(s.padEnd(9));
  const doc = req.document;
  out.info(
    `${label("Document:")} ${brand.value(doc.title)} ${brand.muted(`(v${doc.versionNumber}, SHA-256 ${shortSha(doc.sha256)})`)}`,
  );
  if (opts.withStatus) {
    const when = [
      req.sentAt ? `sent ${timestamp(req.sentAt)}` : null,
      req.completedAt ? `completed ${timestamp(req.completedAt)}` : null,
    ].filter(Boolean);
    out.info(`${label("Status:")} ${brand.value(req.status)}${when.length ? brand.muted(` · ${when.join(" · ")}`) : ""}`);
  }
  out.info(`${label("Request:")} ${req.id}`);
  out.info(`${brand.label("Signers")} ${brand.muted(`(${orderLine(req.order)}):`)}`);
  const signers = [...req.signers].sort((a, b) => a.order - b.order);
  signers.forEach((s, i) => {
    const status = opts.withStatus ? brand.muted(` · ${SIGNER_STATUS_LABELS[s.status] ?? s.status}`) : "";
    out.info(`  ${formatSigner(s, s.order || i + 1)}${status}`);
  });

  const subject = req.message?.subject?.trim();
  const body = req.message?.body?.trim();
  if (!subject && !body) {
    out.info(`${label("Email:")} ${brand.muted("the standard DocuSeal invitation (no custom subject or message)")}`);
  } else {
    if (subject) out.info(`${label("Subject:")} ${subject}`);
    if (body) {
      const [first, ...rest] = body.split(/\r?\n/);
      out.info(`${label("Message:")} ${first}`);
      for (const line of rest) out.info(`${" ".repeat(10)}${line}`);
    }
  }
  out.info(`${label("Expires:")} ${dateOnly(req.expiresAt) ?? brand.muted("no expiry date")}`);
  out.info(
    `${label("File to:")} ${
      req.fileTo
        ? `${brand.value(req.fileTo.name)} ${brand.muted("(Google Drive, once everyone has signed)")}`
        : brand.muted("not filed automatically")
    }`,
  );

  if (req.filed && req.filed.files.length > 0) {
    const dest = typeof req.filed.destination === "string" ? req.filed.destination : req.filed.destination?.name;
    out.info(`${brand.label("Filed")}${dest ? ` to ${brand.value(dest)}` : ""}:`);
    for (const f of req.filed.files) {
      out.info(`  ${f.name}`);
      out.info(`  ${brand.url(f.url)}`);
    }
  }

  for (const w of req.warnings ?? []) out.warn(w);
}

/** What the agent (or human) should do next with this request. */
export function printNextStep(out: Output, req: SignatureRequest) {
  if (!["draft", "pending", "completed"].includes(req.status)) return;
  out.info("");
  switch (req.status) {
    case "draft":
      if (req.confirmation.mode === "browser") {
        out.info(
          `${brand.purpleBold("Next step:")} Ask the user to open this link and click Send. API keys can't send in this workspace.`,
        );
        out.info(`  ${brand.url(req.confirmation.approveUrl)}`);
        out.info(brand.muted(`Preview the exact PDF signers will get: opendocs sign download ${req.id} --kind draft`));
      } else {
        out.info(
          `${brand.purpleBold("Next step:")} Read these signers back to the user and get an explicit yes, then run:`,
        );
        out.info(`  opendocs sign send ${req.id} --yes`);
        out.info(
          brand.muted(`Offer the user the exact PDF signers will get first: opendocs sign download ${req.id} --kind draft`),
        );
      }
      return;
    case "pending":
      out.info(`${brand.purpleBold("Follow up:")} opendocs sign status ${req.id}`);
      return;
    case "completed":
      out.info(`${brand.purpleBold("Download:")} opendocs sign download ${req.id}  ${brand.muted("(--audit for the signing certificate)")}`);
      if (!req.filed) out.info(`${brand.purpleBold("File it:")}  opendocs sign save ${req.id} --folder <name>`);
      return;
    default:
      return;
  }
}
