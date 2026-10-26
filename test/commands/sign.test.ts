import { describe, test, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { makeRunCli, type RunCli } from "../helpers/run-cli.js";
import { startMockApi, respondJson, respondBinary, type MockApi } from "../helpers/mock-api.js";

/**
 * `opendocs sign …` against the integrations spec. The harness never runs
 * the CLI in a pty, so `isTTY` is false and the non-interactive rules are
 * what's covered here: `send` / `cancel` refuse without --yes and make no
 * request. The interactive y/N prompt is a secondary UX layer.
 */

const APPROVE_URL = "https://opendocs.cc/dashboard/integrations/signatures/sr_1";
const SHA = "3f2a9c1e04b7d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e";

function draft(overrides: Record<string, unknown> = {}) {
  return {
    id: "sr_1",
    status: "draft",
    provider: "docuseal",
    document: { postId: "p_1", slug: "employment-agreement", title: "Employment agreement", versionNumber: 3, sha256: SHA },
    signers: [
      { name: "John Adams", email: "adams@company.com", role: "Employee", order: 1, status: "draft" },
      { name: "Jón Jónsson", email: "jon@acme.is", role: "Board member", order: 2, status: "draft" },
    ],
    order: "sequential",
    message: { subject: "Please sign: Employment agreement", body: "Hi John,\nHere is the agreement we discussed." },
    expiresAt: "2026-11-30T23:59:59.000Z",
    fileTo: { id: "dst_2", name: "Signed agreements" },
    confirmation: { mode: "chat", approveUrl: APPROVE_URL },
    warnings: ["adams@company.com is outside your workspace's email domains."],
    createdAt: "2026-10-24T12:00:00.000Z",
    ...overrides,
  };
}

function sent() {
  const d = draft();
  return {
    ...d,
    status: "pending",
    sentAt: "2026-10-24T12:05:00.000Z",
    signers: [
      { ...d.signers[0], status: "sent" },
      { ...d.signers[1], status: "awaiting" },
    ],
  };
}

describe("commands: sign", () => {
  let api: MockApi;
  let harness: ReturnType<typeof makeRunCli>;
  let run: RunCli;
  let opts: { apiUrl: string; config: { apiKey: string; apiUrl: string; workspaceId: string } };

  beforeEach(async () => {
    api = await startMockApi();
    harness = makeRunCli();
    run = harness.run;
    opts = { apiUrl: api.url, config: { apiKey: "od_live_x", apiUrl: api.url, workspaceId: "ws_1" } };
  });

  afterEach(async () => {
    harness.cleanup();
    await api.close();
  });

  // ── request ─────────────────────────────────────────────────────────────

  test("sign request POSTs a draft with parsed signers, order, message, expiry, file-to and version", async () => {
    api.on("POST", "/api/v1/posts/:postId/signature-requests", (req, res) => {
      expect(req.params.postId).toBe("employment-agreement");
      expect(req.body).toEqual({
        workspaceId: "ws_1",
        signers: [
          { name: "John Adams", email: "adams@company.com", role: "Employee" },
          { name: "Jón Jónsson", email: "jon@acme.is" },
        ],
        order: "sequential",
        message: { subject: "Please sign: Employment agreement", body: "Hi John" },
        expiresAt: "2026-11-30",
        fileTo: "Signed agreements",
        versionNumber: 3,
      });
      respondJson(res, draft(), 201);
    });

    const result = await run(
      [
        "sign", "request", "employment-agreement",
        "--signer", "Employee=John Adams <adams@company.com>",
        "--signer", "Jón Jónsson <jon@acme.is>",
        "--subject", "Please sign: Employment agreement",
        "--message", "Hi John",
        "--expires", "2026-11-30",
        "--file-to", "Signed agreements",
        "--version", "3",
        "--sequential",
      ],
      opts,
    );

    expect(result.exitCode).toBe(0);
    // Creating a draft never sends.
    expect(api.calls.map((c) => `${c.method} ${c.url.split("?")[0]}`)).toEqual([
      "POST /api/v1/posts/employment-agreement/signature-requests",
    ]);
  });

  test("sign request prints a read-back summary and the chat-mode next step", async () => {
    api.on("POST", "/api/v1/posts/:postId/signature-requests", (_req, res) => respondJson(res, draft(), 201));

    const result = await run(
      ["sign", "request", "p_1", "--signer", "Employee=John Adams <adams@company.com>", "--signer", "Board member=Jón Jónsson <jon@acme.is>"],
      opts,
    );

    expect(result.exitCode).toBe(0);
    const out = result.stdout;
    expect(result.stderr + out).toContain("Draft signature request created. Nothing has been sent yet.");
    expect(out).toContain("Document: Employment agreement (v3, SHA-256 3f2a9c1e04b7)");
    expect(out).toContain("Request:  sr_1");
    expect(out).toContain("Signers (sequential: each signer is emailed after the previous one has signed):");
    expect(out).toContain("  1. John Adams <adams@company.com> — Employee\n");
    expect(out).toContain("  2. Jón Jónsson <jon@acme.is> — Board member\n");
    expect(out).toContain("Subject:  Please sign: Employment agreement");
    expect(out).toContain("Message:  Hi John,\n            Here is the agreement we discussed.");
    expect(out).toContain("Expires:  2026-11-30");
    expect(out).toContain("File to:  Signed agreements (Google Drive, once everyone has signed)");
    expect(out).toContain("⚠ adams@company.com is outside your workspace's email domains.");
    expect(out).toContain("Next step: Read these signers back to the user and get an explicit yes, then run:");
    expect(out.split("\n").map((l) => l.trim())).toContain("opendocs sign send sr_1 --yes");
    expect(out).toContain("Offer the user the exact PDF signers will get first: opendocs sign download sr_1 --kind draft");
  });

  test("sign request --parallel in browser mode points the user at the approve URL", async () => {
    api.on("POST", "/api/v1/posts/:postId/signature-requests", (req, res) => {
      expect((req.body as { order: string }).order).toBe("parallel");
      expect(req.body).not.toHaveProperty("message");
      expect(req.body).not.toHaveProperty("fileTo");
      respondJson(
        res,
        draft({
          order: "parallel",
          message: null,
          expiresAt: null,
          fileTo: null,
          warnings: [],
          signers: [{ name: "John Adams", email: "adams@company.com", role: null, order: 1, status: "draft" }],
          confirmation: { mode: "browser", approveUrl: APPROVE_URL },
        }),
        201,
      );
    });

    const result = await run(["sign", "request", "p_1", "--signer", "John Adams <adams@company.com>", "--parallel"], opts);

    expect(result.exitCode).toBe(0);
    const out = result.stdout;
    expect(out).toContain("Signers (parallel: everyone is emailed at once):");
    expect(out).toContain("  1. John Adams <adams@company.com>\n");
    expect(out).toContain("Email:    the standard DocuSeal invitation");
    expect(out).toContain("Expires:  no expiry date");
    expect(out).toContain("File to:  not filed automatically");
    expect(out).toContain("Next step: Ask the user to open this link and click Send. API keys can't send in this workspace.");
    expect(out.split("\n").map((l) => l.trim())).toContain(APPROVE_URL);
    expect(out).not.toContain("opendocs sign send");
    expect(out).toContain("Preview the exact PDF signers will get: opendocs sign download sr_1 --kind draft");
  });

  test("sign request --json prints the request object", async () => {
    const body = draft();
    api.on("POST", "/api/v1/posts/:postId/signature-requests", (_req, res) => respondJson(res, body, 201));
    const result = await run(["--json", "sign", "request", "p_1", "--signer", "John Adams <adams@company.com>"], opts);
    expect(result.exitCode).toBe(0);
    expect(result.json()).toEqual(body);
  });

  test.each([
    [["--signer", "adams@company.com"], /has no name/],
    [["--signer", "John Adams <adams@company>"], /not a valid email address/],
    [[], /at least one --signer/],
    [["--signer", "A=John <j@acme.com>", "--signer", "A=Jane <jane@acme.com>"], /Each role has exactly one signer/],
  ])("sign request rejects bad signers %j before any request", async (signerArgs, message) => {
    const result = await run(["--json", "sign", "request", "p_1", ...signerArgs], opts);
    expect(result.exitCode).toBe(1);
    const err = JSON.parse(result.stderr);
    expect(err.error).toBe("invalid_signers");
    expect(err.message).toMatch(message);
    expect(api.calls).toHaveLength(0);
  });

  test("sign request rejects a malformed --expires before any request", async () => {
    const result = await run(
      ["--json", "sign", "request", "p_1", "--signer", "John Adams <adams@company.com>", "--expires", "30/11/2026"],
      opts,
    );
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stderr)).toMatchObject({ error: "invalid_date" });
    expect(api.calls).toHaveLength(0);
  });

  test("sign request on signer_roles_mismatch lists the block's roles", async () => {
    api.on("POST", "/api/v1/posts/:postId/signature-requests", (_req, res) =>
      respondJson(
        res,
        {
          error: "signer_roles_mismatch",
          message: "Every role in the signature block needs exactly one signer.",
          roles: ["Employee", "Board member"],
        },
        400,
      ),
    );

    const human = await run(["sign", "request", "p_1", "--signer", "John Adams <adams@company.com>"], opts);
    expect(human.exitCode).toBe(1);
    expect(human.stderr).toContain("Every role in the signature block needs exactly one signer.");
    expect(human.stderr).toContain("  • Employee\n  • Board member");
    expect(human.stderr).toContain('--signer "Employee=Name <email>"');

    const json = await run(["--json", "sign", "request", "p_1", "--signer", "John Adams <adams@company.com>"], opts);
    expect(JSON.parse(json.stderr)).toEqual({
      error: "signer_roles_mismatch",
      message: "Every role in the signature block needs exactly one signer.",
      roles: ["Employee", "Board member"],
    });
  });

  test("sign request on integration_not_connected / plan_required / destination_not_found", async () => {
    let body: Record<string, unknown> = {};
    let status = 409;
    api.on("POST", "/api/v1/posts/:postId/signature-requests", (_req, res) => respondJson(res, body, status));
    const args = ["sign", "request", "p_1", "--signer", "John Adams <adams@company.com>", "--file-to", "Signed"];

    body = { error: "integration_not_connected", message: "DocuSeal isn't connected.", provider: "docuseal" };
    const notConnected = await run(args, opts);
    expect(notConnected.exitCode).toBe(1);
    expect(notConnected.stderr).toContain("DocuSeal isn't connected.");
    expect(notConnected.stderr).toContain("DocuSeal isn't connected to this workspace. An owner or admin can connect it");

    body = { error: "plan_required", message: "Signatures need Pro or Team." };
    status = 403;
    const plan = await run(args, opts);
    expect(plan.stderr).toContain("Signatures need Pro or Team.");
    expect(plan.stderr).toContain("https://opendocs.cc/dashboard/billing");

    body = { error: "destination_not_found", message: 'No Drive folder named "Signed".', destinations: ["Signed agreements"] };
    status = 404;
    const dest = await run(args, opts);
    expect(dest.stderr).toContain('No Drive folder named "Signed".');
    expect(dest.stderr).toContain("Available folders:\n  • Signed agreements");
  });

  // ── send ────────────────────────────────────────────────────────────────

  test("sign send without --yes outside a terminal fails with confirm_required and makes no request", async () => {
    const result = await run(["--json", "sign", "send", "sr_1"], opts);
    expect(result.exitCode).toBe(1);
    const err = JSON.parse(result.stderr);
    expect(err.error).toBe("confirm_required");
    expect(err.message).toContain("opendocs sign send sr_1 --yes");
    expect(api.calls).toHaveLength(0);

    const human = await run(["sign", "send", "sr_1"], opts);
    expect(human.exitCode).toBe(1);
    expect(human.stderr).toContain("Refusing to send without confirmation.");
    expect(api.calls).toHaveLength(0);
  });

  test("sign send --yes POSTs { confirm: true } and shows signer statuses", async () => {
    api.on("POST", "/api/v1/signature-requests/:id/send", (req, res) => {
      expect(req.params.id).toBe("sr_1");
      expect(req.body).toEqual({ confirm: true, workspaceId: "ws_1" });
      respondJson(res, sent());
    });

    const result = await run(["sign", "send", "sr_1", "--yes"], opts);

    expect(result.exitCode).toBe(0);
    expect(result.stderr + result.stdout).toContain("Sent Employment agreement (v3) for signature");
    expect(result.stdout).toContain("Status:   pending · sent 2026-10-24 12:05 UTC");
    expect(result.stdout).toContain("1. John Adams <adams@company.com> — Employee · email sent");
    expect(result.stdout).toContain("2. Jón Jónsson <jon@acme.is> — Board member · waiting for the previous signer");
    expect(result.stdout).toContain("Follow up: opendocs sign status sr_1");
  });

  test("sign send --yes --json prints the sent request", async () => {
    api.on("POST", "/api/v1/signature-requests/:id/send", (_req, res) => respondJson(res, sent()));
    const result = await run(["--json", "sign", "send", "sr_1", "-y"], opts);
    expect(result.exitCode).toBe(0);
    expect(result.json()).toEqual(sent());
  });

  test("sign send on approval_required prints the approve URL", async () => {
    api.on("POST", "/api/v1/signature-requests/:id/send", (_req, res) =>
      respondJson(
        res,
        { error: "approval_required", message: "This workspace requires sending from the dashboard.", approveUrl: APPROVE_URL },
        403,
      ),
    );

    const human = await run(["sign", "send", "sr_1", "--yes"], opts);
    expect(human.exitCode).toBe(1);
    expect(human.stderr).toContain("This workspace requires sending from the dashboard.");
    expect(human.stderr).toContain("Ask the user to open this link and click Send:");
    expect(human.stderr.split("\n").map((l) => l.trim())).toContain(APPROVE_URL);

    const json = await run(["--json", "sign", "send", "sr_1", "--yes"], opts);
    expect(JSON.parse(json.stderr)).toEqual({
      error: "approval_required",
      message: "This workspace requires sending from the dashboard.",
      approveUrl: APPROVE_URL,
    });
  });

  test("sign send on already_sent points at sign status", async () => {
    api.on("POST", "/api/v1/signature-requests/:id/send", (_req, res) =>
      respondJson(res, { error: "already_sent", message: "Already sent.", status: "pending" }, 409),
    );
    const human = await run(["sign", "send", "sr_1", "--yes"], opts);
    expect(human.exitCode).toBe(1);
    expect(human.stderr).toContain("Already sent.");
    expect(human.stderr).toContain("opendocs sign status sr_1");

    const json = await run(["--json", "sign", "send", "sr_1", "--yes"], opts);
    expect(JSON.parse(json.stderr)).toEqual({ error: "already_sent", message: "Already sent.", status: "pending" });
  });

  // ── status / list ───────────────────────────────────────────────────────

  test("sign status GETs the request and shows filed copies once completed", async () => {
    api.on("GET", "/api/v1/signature-requests/:id", (req, res) => {
      expect(req.params.id).toBe("sr_1");
      expect(req.query.get("workspaceId")).toBe("ws_1");
      const d = draft();
      respondJson(res, {
        ...d,
        status: "completed",
        sentAt: "2026-10-24T12:05:00.000Z",
        completedAt: "2026-10-25T09:30:00.000Z",
        signers: d.signers.map((s) => ({ ...s, status: "completed" })),
        filed: {
          destination: { id: "dst_2", name: "Signed agreements" },
          files: [
            { name: "Employment agreement (signed).pdf", url: "https://drive.google.com/file/d/s1/view" },
            { name: "Employment agreement (certificate).pdf", url: "https://drive.google.com/file/d/s2/view" },
          ],
        },
      });
    });

    const result = await run(["sign", "status", "sr_1"], opts);

    expect(result.exitCode).toBe(0);
    const out = result.stdout;
    expect(out).toContain("Status:   completed · sent 2026-10-24 12:05 UTC · completed 2026-10-25 09:30 UTC");
    expect(out).toContain("1. John Adams <adams@company.com> — Employee · signed");
    expect(out).toContain("Filed to Signed agreements:");
    expect(out.split("\n").map((l) => l.trim())).toContain("https://drive.google.com/file/d/s1/view");
    expect(out).toContain("Download: opendocs sign download sr_1");
    expect(out).not.toContain("opendocs sign save");
  });

  test("sign status --json prints the request object", async () => {
    api.on("GET", "/api/v1/signature-requests/:id", (_req, res) => respondJson(res, sent()));
    const result = await run(["--json", "sign", "status", "sr_1"], opts);
    expect(result.exitCode).toBe(0);
    expect(result.json()).toEqual(sent());
  });

  test("sign list passes workspaceId, a resolved postId and status as query params", async () => {
    const postUuid = "6f1c2b9a-0d4e-4c1b-9a7e-3b2d1c0f9e8a";
    api.on("GET", "/api/v1/posts/:postId", (req, res) => {
      expect(req.params.postId).toBe("employment-agreement");
      expect(req.query.get("workspaceId")).toBe("ws_1");
      respondJson(res, { post: { id: postUuid, slug: "employment-agreement", title: "Employment agreement" } });
    });
    api.on("GET", "/api/v1/signature-requests", (req, res) => {
      expect(req.query.get("workspaceId")).toBe("ws_1");
      expect(req.query.get("postId")).toBe(postUuid);
      expect(req.query.get("status")).toBe("pending");
      respondJson(res, { requests: [sent()] });
    });

    const result = await run(["sign", "list", "--doc", "employment-agreement", "--status", "pending"], opts);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Signature requests (1):");
    expect(result.stdout).toMatch(/sr_1\s+pending\s+Employment agreement v3\s+0 of 2 signed\s+2026-10-24/);
  });

  test("sign list --json, a UUID --doc is used as-is, and an empty list", async () => {
    const postUuid = "6f1c2b9a-0d4e-4c1b-9a7e-3b2d1c0f9e8a";
    api.on("GET", "/api/v1/signature-requests", (req, res) => {
      expect(req.query.get("postId")).toBe(postUuid);
      expect(req.query.has("status")).toBe(false);
      respondJson(res, { requests: [] });
    });

    const json = await run(["--json", "sign", "list", "--doc", postUuid], opts);
    expect(json.exitCode).toBe(0);
    expect(json.json()).toEqual({ requests: [] });

    const human = await run(["sign", "list", "--doc", postUuid], opts);
    expect(human.stdout).toContain("No signature requests.");
    // No slug lookup for UUIDs.
    expect(api.calls.every((c) => c.url.startsWith("/api/v1/signature-requests"))).toBe(true);
  });

  test("sign list rejects an unknown --status before any request", async () => {
    const result = await run(["--json", "sign", "list", "--status", "sent"], opts);
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stderr)).toMatchObject({ error: "invalid_status" });
    expect(api.calls).toHaveLength(0);
  });

  // ── cancel ──────────────────────────────────────────────────────────────

  test("sign cancel without --yes outside a terminal fails with confirm_required and makes no request", async () => {
    const result = await run(["--json", "sign", "cancel", "sr_1"], opts);
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stderr)).toMatchObject({ error: "confirm_required" });
    expect(api.calls).toHaveLength(0);
  });

  test("sign cancel --yes sends DELETE with the workspace", async () => {
    api.on("DELETE", "/api/v1/signature-requests/:id", (req, res) => {
      expect(req.params.id).toBe("sr_1");
      expect(req.query.get("workspaceId")).toBe("ws_1");
      respondJson(res, { ...sent(), status: "cancelled" });
    });

    const result = await run(["--json", "sign", "cancel", "sr_1", "--yes"], opts);
    expect(result.exitCode).toBe(0);
    expect(result.json()).toMatchObject({ id: "sr_1", status: "cancelled" });

    const human = await run(["sign", "cancel", "sr_1", "--yes"], opts);
    expect(human.stderr + human.stdout).toContain("Cancelled the signature request for Employment agreement (sr_1)");
  });

  test("sign cancel on already_completed shows the server message", async () => {
    api.on("DELETE", "/api/v1/signature-requests/:id", (_req, res) =>
      respondJson(res, { error: "already_completed", message: "Everyone has already signed." }, 409),
    );
    const result = await run(["--json", "sign", "cancel", "sr_1", "--yes"], opts);
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stderr)).toEqual({ error: "already_completed", message: "Everyone has already signed." });
  });

  // ── download ────────────────────────────────────────────────────────────

  test("sign download writes the signed PDF under the Content-Disposition filename", async () => {
    const pdf = Buffer.from("%PDF-1.7 signed");
    api.on("GET", "/api/v1/signature-requests/:id/documents/:kind", (req, res) => {
      expect(req.params).toEqual({ id: "sr_1", kind: "signed" });
      expect(req.query.get("workspaceId")).toBe("ws_1");
      respondBinary(res, pdf, { contentType: "application/pdf", filename: "Employment agreement (signed).pdf" });
    });

    const result = await run(["--json", "sign", "download", "sr_1"], opts);

    expect(result.exitCode).toBe(0);
    const outPath = path.join(result.cwd, "Employment agreement (signed).pdf");
    expect(fs.readFileSync(outPath)).toEqual(pdf);
    expect(result.json()).toMatchObject({ id: "sr_1", kind: "signed", bytes: pdf.length });
  });

  test("sign download --audit -o <path> writes the certificate to that path", async () => {
    const pdf = Buffer.from("%PDF-1.7 audit");
    api.on("GET", "/api/v1/signature-requests/:id/documents/:kind", (req, res) => {
      expect(req.params.kind).toBe("audit");
      respondBinary(res, pdf, { contentType: "application/pdf", filename: "certificate.pdf" });
    });

    const cwd = fs.mkdtempSync(path.join(harness.configDir, "dl-"));
    // The parent folder doesn't exist yet; download creates it.
    const result = await run(["sign", "download", "sr_1", "--audit", "-o", "out/cert.pdf"], { ...opts, cwd });
    expect(result.exitCode).toBe(0);
    expect(result.stderr + result.stdout).toContain("Downloaded the signing certificate cert.pdf");
    expect(fs.readFileSync(path.join(cwd, "out", "cert.pdf"))).toEqual(pdf);

    // A directory gets the server's filename inside it.
    const dirResult = await run(["sign", "download", "sr_1", "--audit", "-o", "certs/"], { ...opts, cwd });
    expect(dirResult.exitCode).toBe(0);
    expect(fs.readFileSync(path.join(cwd, "certs", "certificate.pdf"))).toEqual(pdf);
  });

  test("sign download --kind draft (or --draft) fetches the draft's exact PDF", async () => {
    const pdf = Buffer.from("%PDF-1.7 draft");
    api.on("GET", "/api/v1/signature-requests/:id/documents/:kind", (req, res) => {
      expect(req.params).toEqual({ id: "sr_1", kind: "draft" });
      respondBinary(res, pdf, { contentType: "application/pdf", filename: "Employment agreement (draft).pdf" });
    });

    const long = await run(["--json", "sign", "download", "sr_1", "--kind", "draft"], opts);
    expect(long.exitCode).toBe(0);
    expect(long.json()).toMatchObject({ id: "sr_1", kind: "draft", bytes: pdf.length });
    expect(fs.readFileSync(path.join(long.cwd, "Employment agreement (draft).pdf"))).toEqual(pdf);

    const short = await run(["sign", "download", "sr_1", "--draft"], opts);
    expect(short.exitCode).toBe(0);
    expect(short.stderr + short.stdout).toContain("Downloaded the draft PDF Employment agreement (draft).pdf");
    expect(api.calls).toHaveLength(2);
  });

  test("sign download rejects an unknown --kind and conflicting kind flags before any request", async () => {
    const bad = await run(["--json", "sign", "download", "sr_1", "--kind", "preview"], opts);
    expect(bad.exitCode).toBe(1);
    expect(JSON.parse(bad.stderr)).toMatchObject({ error: "invalid_kind" });

    const both = await run(["--json", "sign", "download", "sr_1", "--draft", "--audit"], opts);
    expect(both.exitCode).toBe(1);
    expect(JSON.parse(both.stderr)).toMatchObject({ error: "conflicting_options" });

    const mixed = await run(["--json", "sign", "download", "sr_1", "--kind", "signed", "--audit"], opts);
    expect(mixed.exitCode).toBe(1);
    expect(JSON.parse(mixed.stderr)).toMatchObject({ error: "conflicting_options" });

    expect(api.calls).toHaveLength(0);
  });

  test("sign download --kind draft after sending explains not_available", async () => {
    api.on("GET", "/api/v1/signature-requests/:id/documents/:kind", (_req, res) =>
      respondJson(res, { error: "not_available", message: "The draft PDF is gone once a request is sent." }, 404),
    );
    const result = await run(["sign", "download", "sr_1", "--kind", "draft"], opts);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("The draft PDF is gone once a request is sent.");
    expect(result.stderr).toContain("The draft PDF only exists until the request is sent.");
    expect(result.stderr).toContain("opendocs sign status sr_1");
  });

  test("sign download on not_completed says to check status", async () => {
    api.on("GET", "/api/v1/signature-requests/:id/documents/:kind", (_req, res) =>
      respondJson(res, { error: "not_completed", message: "Not everyone has signed yet." }, 409),
    );
    const result = await run(["sign", "download", "sr_1"], opts);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Not everyone has signed yet.");
    expect(result.stderr).toContain("opendocs sign status sr_1");
    expect(fs.readdirSync(result.cwd)).toEqual([]);
  });

  // ── save ────────────────────────────────────────────────────────────────

  test("sign save POSTs the destination and lists the saved files", async () => {
    api.on("POST", "/api/v1/signature-requests/:id/storage", (req, res) => {
      expect(req.params.id).toBe("sr_1");
      expect(req.body).toEqual({ destination: "Signed agreements", workspaceId: "ws_1" });
      respondJson(
        res,
        {
          destination: { id: "dst_2", name: "Signed agreements" },
          files: [
            { kind: "signed", id: "f1", name: "Employment agreement (signed).pdf", url: "https://drive.google.com/file/d/f1/view", sha256: SHA, driveSha256: SHA, verified: true },
            { kind: "audit", id: "f2", name: "Employment agreement (certificate).pdf", url: "https://drive.google.com/file/d/f2/view", sha256: SHA, driveSha256: SHA, verified: true },
          ],
        },
        201,
      );
    });

    const result = await run(["sign", "save", "sr_1", "--folder", "Signed agreements"], opts);

    expect(result.exitCode).toBe(0);
    expect(result.stderr + result.stdout).toContain("Saved 2 files to Signed agreements");
    expect(result.stdout).toContain("Employment agreement (signed).pdf (signed PDF)");
    expect(result.stdout).toContain("Employment agreement (certificate).pdf (signing certificate)");
    const lines = result.stdout.split("\n").map((l) => l.trim());
    expect(lines).toContain("https://drive.google.com/file/d/f1/view");
    expect(lines).toContain("https://drive.google.com/file/d/f2/view");
    expect(result.stdout).toContain(`SHA-256: ${SHA}`);
  });

  test("sign save on not_completed / destination_not_found", async () => {
    let body: Record<string, unknown> = { error: "not_completed", message: "Not everyone has signed yet." };
    api.on("POST", "/api/v1/signature-requests/:id/storage", (_req, res) => respondJson(res, body, body.error === "not_completed" ? 409 : 404));

    const notDone = await run(["--json", "sign", "save", "sr_1", "--folder", "Signed agreements"], opts);
    expect(notDone.exitCode).toBe(1);
    expect(JSON.parse(notDone.stderr)).toEqual({ error: "not_completed", message: "Not everyone has signed yet." });

    body = { error: "destination_not_found", message: "No such folder.", destinations: [] };
    const missing = await run(["sign", "save", "sr_1", "--folder", "Nope"], opts);
    expect(missing.exitCode).toBe(1);
    expect(missing.stderr).toContain("No Drive folders are set up yet.");
  });
});
