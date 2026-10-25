import { clearConfig, type CliConfig } from "./config.js";
import { CLI_VERSION } from "./version.js";
import { getClientName } from "./client-id.js";
import { showRateLimitWait } from "./output.js";

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    /** The full JSON error body, for callers that need extra fields. */
    public details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "ApiError";
  }
}

type ErrorBody = {
  error?: string;
  message?: string;
  docs_url?: string;
  issues?: { formErrors?: string[]; fieldErrors?: Record<string, string[] | undefined> };
};

// Prefer the server's `message`; older servers only sent Zod `issues` on
// validation errors, so flatten those into "field: problem" instead of a
// bare "Request failed with status 400".
export function errorMessageFromBody(data: ErrorBody, status: number): string {
  if (data.message) return data.message;
  const fieldErrors = Object.entries(data.issues?.fieldErrors ?? {})
    .flatMap(([field, messages]) => (messages ?? []).map((m) => `${field}: ${m}`));
  const all = [...(data.issues?.formErrors ?? []), ...fieldErrors];
  if (all.length > 0) return all.join("; ");
  return `Request failed with status ${status}`;
}

async function apiErrorFromResponse(res: Response): Promise<ApiError> {
  const data = (await res.json().catch(() => ({}))) as ErrorBody & Record<string, unknown>;
  const message = errorMessageFromBody(data, res.status);
  return new ApiError(res.status, data.error || "api_error", message, data);
}

// A 429 means a rate limiter turned the request away before any work was
// done, so sending it again is safe even for POSTs. Short waits (the API's
// per-minute buckets, its cap on exports running at once) are waited out, so
// a big publish or export slows down instead of failing part-way. Long ones
// (hourly anonymous limits, sign-in codes) go straight back to the caller.
const RATE_LIMIT_MAX_WAIT_SECONDS = 90;
const RATE_LIMIT_MAX_RETRIES = 5;

export function retryAfterSeconds(headers: Headers): number {
  const raw = headers.get("retry-after") ?? headers.get("ratelimit-reset");
  if (raw) {
    const seconds = Number(raw);
    if (Number.isFinite(seconds)) return Math.max(0, Math.ceil(seconds));
    const date = Date.parse(raw);
    if (!Number.isNaN(date)) return Math.max(0, Math.ceil((date - Date.now()) / 1000));
  }
  return 10;
}

export async function sendRespectingRateLimits(
  send: () => Promise<Response>,
  opts?: { beforeWait?: () => void },
): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const res = await send();
    if (res.status !== 429 || attempt >= RATE_LIMIT_MAX_RETRIES) return res;
    const seconds = retryAfterSeconds(res.headers);
    if (seconds > RATE_LIMIT_MAX_WAIT_SECONDS) return res;
    await res.body?.cancel().catch(() => {});
    opts?.beforeWait?.();
    const restore = showRateLimitWait(seconds);
    try {
      await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
    } finally {
      restore();
    }
  }
}

function requestHeaders(apiKey: string | undefined, extra?: Record<string, string>) {
  return {
    ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    "Content-Type": "application/json",
    "User-Agent": `opendocs-cli/${CLI_VERSION}`,
    "X-OpenDocs-Client": getClientName(),
    ...extra,
  };
}

export type BatchExportResult =
  | {
      postId: string;
      success: true;
      slug: string;
      filename: string;
      bytes: number;
    }
  | {
      postId: string;
      success: false;
      error: string;
      message: string;
    };

export interface BatchExportManifest {
  format: "docx" | "pdf";
  results: BatchExportResult[];
  summary: { total: number; succeeded: number; failed: number };
}

export type BatchPublishResult =
  | {
      success: true;
      index: number;
      postId: string;
      slug: string;
      title: string;
      url: string;
      projectId: string;
      projectSlug: string;
      projectName: string;
      isDefaultProject: boolean;
    }
  | {
      success: false;
      index: number;
      error: string;
      message: string;
    };

export interface BatchPublishSummary {
  total: number;
  succeeded: number;
  failed: number;
}

export type BatchPublishStreamEvent =
  | { type: "result"; data: BatchPublishResult }
  | { type: "summary"; data: BatchPublishSummary };

// Build the `?workspaceId=...` suffix used by every single-post endpoint.
// Returns an empty string when no workspace is scoped so route shapes stay
// clean in the no-scope case. Kept as a free function (not a method on the
// returned client) so the call sites read tersely.
function postScopeQuery(opts?: { workspaceId?: string; projectId?: string }): string {
  if (!opts?.workspaceId && !opts?.projectId) return "";
  const params = new URLSearchParams();
  if (opts?.workspaceId) params.set("workspaceId", opts.workspaceId);
  if (opts?.projectId) params.set("projectId", opts.projectId);
  return `?${params.toString()}`;
}

export type BrandingPreset = {
  id: string;
  name: string;
  description: string;
  brandColor: string;
  fontId: string;
};

export type WorkspaceBranding = {
  workspace: { id: string; slug: string; name: string };
  role: "owner" | "admin" | "member";
  tier: string;
  /** Owners and admins on any plan: color, font, presets, logo. */
  canEdit: boolean;
  /** Owners and admins on Pro or Team. Missing from older API servers. */
  canEditFooter?: boolean;
  branding: {
    brandColor: string;
    font: string;
    preset: string | null;
    contrast: { contrast: number; level: "great" | "ok" | "too_light" };
    logoUrl: string | null;
    showLogoInExports: boolean;
    footer: {
      enabled: boolean;
      companyName: string | null;
      tagline: string | null;
      linkUrl: string | null;
      linkLabel: string | null;
    };
  };
  presets: BrandingPreset[];
  fonts: Array<{ id: string; label: string; category: string; description: string }>;
  guidelines: { minContrast: number; recommendedContrast: number; rules: string[] };
};

export type BrandingUpdate = {
  preset?: string;
  brandColor?: string;
  font?: string;
  showLogoInExports?: boolean;
  footer?: {
    enabled?: boolean;
    companyName?: string | null;
    tagline?: string | null;
    linkUrl?: string | null;
    linkLabel?: string | null;
  };
  allowLowContrast?: boolean;
};

// ── Integrations (Google Drive storage, DocuSeal signatures) ─────────────

export type IntegrationStatus = "connected" | "not_connected" | "error";

/** A Drive folder the workspace picked in the dashboard and gave a name. */
export type StorageDestination = {
  id: string;
  name: string;
  folderName?: string;
  driveName?: string | null;
  url?: string;
};

export type Integration = {
  provider: "google_drive" | "docuseal" | (string & {});
  name: string;
  capabilities: string[];
  status: IntegrationStatus;
  account: string | null;
  connectedAt: string | null;
  /** DocuSeal only: `com` (api.docuseal.com), `eu` (api.docuseal.eu) or `custom` (self-hosted). */
  region?: "com" | "eu" | "custom" | null;
  /** Set when `status` is `error`, e.g. Google access revoked. */
  error?: string | null;
  /** Google Drive only. */
  destinations?: StorageDestination[];
};

export type IntegrationsOverview = {
  workspace: { id: string; slug: string; name: string };
  tier: string;
  role: "owner" | "admin" | "member";
  canManage: boolean;
  canUse: boolean;
  settings: {
    usableBy: "members" | "admins";
    signatureConfirmation: "chat" | "browser";
  };
  dashboardUrl: string;
  integrations: Integration[];
};

export type StorageFormat = "pdf" | "docx" | "md";

export type StoredFile = {
  id: string;
  name: string;
  url: string;
  sha256: string;
  /** Google's own SHA-256 of the uploaded file; null if Drive didn't report one. */
  driveSha256: string | null;
  verified: boolean;
};

export type StorageRun = {
  id: string;
  provider: string;
  destination: { id: string; name: string };
  document: { postId: string; slug: string; title: string; versionNumber: number };
  file: StoredFile & { format: StorageFormat; bytes: number };
};

export type SignerInput = { name: string; email: string; role?: string };

export type SignatureRequestStatus =
  | "draft"
  | "pending"
  | "completed"
  | "declined"
  | "expired"
  | "cancelled"
  | "failed";

export type SignerStatus = "draft" | "awaiting" | "sent" | "opened" | "completed" | "declined";

export type SignatureRequest = {
  id: string;
  status: SignatureRequestStatus;
  provider: string;
  document: { postId: string; slug: string; title: string; versionNumber: number; sha256: string };
  signers: Array<{
    name: string;
    email: string;
    role: string | null;
    order: number;
    status: SignerStatus;
  }>;
  order: "sequential" | "parallel";
  message: { subject?: string | null; body?: string | null } | null;
  expiresAt: string | null;
  fileTo: { id: string; name: string } | null;
  confirmation: { mode: "chat" | "browser"; approveUrl: string };
  warnings?: string[];
  /** Why the last send failed (the request stays a draft and can be sent again). */
  lastError?: string | null;
  createdAt: string;
  sentAt?: string | null;
  completedAt?: string | null;
  filed?: {
    destination: { id?: string; name: string } | string;
    files: Array<{ name: string; url: string }>;
  } | null;
};

export type CreateSignatureRequestBody = {
  workspaceId: string;
  signers: SignerInput[];
  order?: "sequential" | "parallel";
  message?: { subject?: string; body?: string };
  expiresAt?: string;
  fileTo?: string;
  versionNumber?: number;
};

/**
 * `draft`: the exact PDF signers will get, only while the request is a draft
 * (404 `not_available` after it's sent). `signed`: the signed PDF. `audit`:
 * the signing certificate / audit log. The last two need a completed request.
 */
export type SignatureDocumentKind = "draft" | "signed" | "audit";

/**
 * Suggested filename from a Content-Disposition header. Prefers the RFC 5987
 * `filename*=UTF-8''…` form (non-ASCII names such as "Stjórnarfundir.pdf"),
 * then the quoted `filename="…"`. Null when the header names no file.
 */
export function filenameFromDisposition(disposition: string | null): string | null {
  if (!disposition) return null;
  const extended = /filename\*\s*=\s*(?:UTF-8|utf-8)''([^;]+)/.exec(disposition);
  if (extended) {
    try {
      return decodeURIComponent(extended[1].trim().replace(/^"|"$/g, ""));
    } catch {
      // Malformed percent-encoding: fall back to the plain form.
    }
  }
  const quoted = /filename\s*=\s*"([^"]+)"/.exec(disposition);
  if (quoted) return quoted[1];
  const bare = /filename\s*=\s*([^;\s]+)/.exec(disposition);
  return bare?.[1] ?? null;
}

export function createApiClient(config: CliConfig) {
  const baseUrl = config.apiUrl.replace(/\/$/, "");

  // Sends one request with its own timeout per attempt, re-sent after a
  // rate-limit wait (see sendRespectingRateLimits).
  function send(method: string, path: string, body: unknown, timeoutMs: number) {
    return sendRespectingRateLimits(async () => {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
      try {
        return await fetch(`${baseUrl}${path}`, {
          method,
          headers: requestHeaders(config.apiKey),
          body: body ? JSON.stringify(body) : undefined,
          signal: controller.signal,
        });
      } catch (err) {
        if (err instanceof Error && err.name === "AbortError") {
          throw new ApiError(
            408,
            "timeout",
            `Request timed out after ${timeoutMs / 1000}s. The server may be slow or unreachable.`,
          );
        }
        throw err;
      } finally {
        clearTimeout(timeoutId);
      }
    });
  }

  async function request<T>(
    method: string,
    path: string,
    body?: unknown,
    opts?: { timeoutMs?: number },
  ): Promise<T> {
    // Default 30s — most calls finish in <1s. Batch publish overrides to 90s
    // since it can run up to 25 DB transactions sequentially server-side.
    const res = await send(method, path, body, opts?.timeoutMs ?? 30_000);

    if (res.status === 401 && config.apiKey) {
      clearConfig();
      throw new ApiError(
        401,
        "auth_expired",
        'Your API key is no longer valid. It may have been revoked.\nRun "opendocs login" to re-authenticate with a new key.',
      );
    }

    if (!res.ok) {
      // Error bodies aren't always JSON — gateways, timeouts, and the
      // occasional Caddy 502 can send plain text or nothing at all. Parse
      // defensively so we surface a useful message either way, and prefer
      // `||` over `??` because an empty-string `message` on the wire is
      // functionally nullish as far as users are concerned.
      throw await apiErrorFromResponse(res);
    }

    const data = await res.json();
    return data as T;
  }

  // Sibling of request() for endpoints that return binary file downloads
  // (e.g. /export/docx, /export/pdf). The API side sets Content-Disposition
  // with a suggested filename — we parse it so callers can save under that
  // name by default.
  //
  // Accepts a timeout override — batch export sizes it to the number of
  // documents so long exports have room to finish.
  async function requestBinary(
    method: string,
    path: string,
    body?: unknown,
    opts?: { timeoutMs?: number },
  ): Promise<{
    buffer: Buffer;
    filename: string;
    contentType: string;
    headers: Headers;
  }> {
    const res = await send(method, path, body, opts?.timeoutMs ?? 60_000);

    if (res.status === 401 && config.apiKey) {
      clearConfig();
      throw new ApiError(
        401,
        "auth_expired",
        'Your API key is no longer valid. It may have been revoked.\nRun "opendocs login" to re-authenticate with a new key.',
      );
    }

    if (!res.ok) {
      // Same defensive parse as request() — binary endpoints (export, etc.)
      // are especially likely to hit non-JSON error bodies when a gateway
      // (Caddy, load balancer) short-circuits before the API can respond.
      // `||` (not `??`) so an empty-string message falls through to the
      // HTTP-status fallback instead of surfacing as "Export failed: ".
      throw await apiErrorFromResponse(res);
    }

    const buffer = Buffer.from(await res.arrayBuffer());
    const filename =
      filenameFromDisposition(res.headers.get("content-disposition")) ?? "document";
    const contentType =
      res.headers.get("content-type") ?? "application/octet-stream";
    return { buffer, filename, contentType, headers: res.headers };
  }

  // Minimal SSE frame parser. Splits the response body on `\n\n` (event
  // boundary) and reads `event:` / `data:` fields. Enough for our server's
  // single-line-data frames; a fuller parser would handle `id:` and `retry:`
  // but we don't need them.
  async function* parseSSE(
    res: Response,
  ): AsyncGenerator<{ event: string; data: string }> {
    if (!res.body) return;
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        if (buffer.trim().length > 0) {
          // Flush any trailing frame at stream end (server should always
          // close with `\n\n` but be defensive).
          const frame = buffer;
          buffer = "";
          const parsed = parseFrame(frame);
          if (parsed.data) yield parsed;
        }
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const parsed = parseFrame(frame);
        if (parsed.data) yield parsed;
      }
    }
  }

  function parseFrame(frame: string): { event: string; data: string } {
    let event = "message";
    let data = "";
    for (const line of frame.split("\n")) {
      if (line.startsWith("event: ")) event = line.slice(7);
      else if (line.startsWith("data: ")) data = line.slice(6);
    }
    return { event, data };
  }

  return {
    me() {
      return request<{
        authenticated: boolean;
        userId: string;
        onboarding: {
          username?: string;
          workspace?: {
            id: string;
            name: string;
            slug: string;
            defaultProject?: {
              id: string;
              name: string;
              slug: string;
              isDefault: boolean;
            };
          };
        };
        quota?: {
          // `null` limit / remaining means "unlimited" (Pro/Team).
          documents: {
            plan: "free" | "pro" | "team";
            limit: number | null;
            used: number;
            remaining: number | null;
          } | null;
        };
      }>("GET", "/api/v1/me");
    },

    // Lists every workspace the authenticated caller is an active member
    // of. Backed by `GET /api/v1/workspaces` (dual auth). Used by the
    // `workspace list` / `workspace use` commands and the login/whoami
    // multi-workspace hints.
    listWorkspaces() {
      return request<{
        workspaces: Array<{
          id: string;
          name: string;
          slug: string;
          role: "owner" | "admin" | "member";
        }>;
      }>("GET", "/api/v1/workspaces");
    },

    listProjects(workspaceId: string) {
      const qs = new URLSearchParams({ workspaceId });
      return request<{
        projects: Array<{
          id: string;
          workspaceId: string;
          name: string;
          slug: string;
          isDefault: boolean;
          postCount: number;
          updatedAt: string;
          recentTitles?: string[];
          lastPublishedAt?: string | null;
        }>;
        defaultProject: {
          id: string;
          workspaceId: string;
          name: string;
          slug: string;
          isDefault: boolean;
        } | null;
      }>("GET", `/api/v1/projects?${qs.toString()}`);
    },

    defaultProject(workspaceId: string) {
      const qs = new URLSearchParams({ workspaceId });
      return request<{
        project: {
          id: string;
          workspaceId: string;
          name: string;
          slug: string;
          isDefault: boolean;
        };
      }>("GET", `/api/v1/projects/default?${qs.toString()}`);
    },

    createProject(body: { workspaceId: string; name: string; slug?: string }) {
      return request<{
        project: {
          id: string;
          workspaceId: string;
          name: string;
          slug: string;
          isDefault: boolean;
        };
      }>("POST", "/api/v1/projects", body);
    },

    renameProject(projectId: string, body: { name?: string; slug?: string }) {
      return request<{
        project: {
          id: string;
          workspaceId: string;
          name: string;
          slug: string;
          isDefault: boolean;
        };
      }>("PATCH", `/api/v1/projects/${encodeURIComponent(projectId)}`, body);
    },

    deleteProject(projectId: string) {
      return request<{ deleted: true; projectId: string }>(
        "DELETE",
        `/api/v1/projects/${encodeURIComponent(projectId)}`,
      );
    },

    publish(body: {
      markdown: string;
      title?: string;
      slug?: string;
      visibility: string;
      workspaceId: string;
      projectId?: string;
      projectSlug?: string;
      tags?: string[];
      sourcePath?: string;
      confirmPublic?: boolean;
    }) {
      return request<{
        postId: string;
        slug: string;
        url: string;
        title: string;
        versionNumber: number;
        projectId: string;
        projectSlug: string;
        projectName: string;
        isDefaultProject: boolean;
      }>("POST", "/api/v1/publish", body);
    },

    publishBatch(body: {
      documents: Array<{
        markdown: string;
        title?: string;
        slug?: string;
        visibility: string;
        workspaceId: string;
        projectId?: string;
        projectSlug?: string;
        tags?: string[];
        sourcePath?: string;
        confirmPublic?: boolean;
      }>;
    }) {
      return request<{
        results: BatchPublishResult[];
        summary: BatchPublishSummary;
      }>("POST", "/api/v1/publish/batch", body, { timeoutMs: 90_000 });
    },

    // Streaming variant of publishBatch — emits one `result` event per doc
    // as it completes, then a final `summary` event. Used in interactive
    // (non-JSON) mode so the user sees live progress; --json mode still uses
    // the plain JSON path so the output is a single parseable object.
    //
    // Uses an idle-timeout rather than a total timeout: each incoming frame
    // resets the clock. 20s idle is plenty between doc completions (single-
    // doc publish is ~1s); a stalled connection surfaces as a clean error.
    async *publishBatchStream(body: {
      documents: Array<{
        markdown: string;
        title?: string;
        slug?: string;
        visibility: string;
        workspaceId: string;
        tags?: string[];
        sourcePath?: string;
        confirmPublic?: boolean;
      }>;
    }): AsyncGenerator<BatchPublishStreamEvent> {
      const controller = new AbortController();
      const IDLE_MS = 20_000;
      let idleTimer: ReturnType<typeof setTimeout> | null = null;
      const resetIdle = () => {
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => controller.abort(), IDLE_MS);
      };
      resetIdle();

      let res: Response;
      try {
        res = await sendRespectingRateLimits(
          () => {
            resetIdle();
            return fetch(`${baseUrl}/api/v1/publish/batch`, {
              method: "POST",
              headers: requestHeaders(config.apiKey, { Accept: "text/event-stream" }),
              body: JSON.stringify(body),
              signal: controller.signal,
            });
          },
          // Otherwise the idle clock runs out during the wait and aborts the retry.
          { beforeWait: () => idleTimer && clearTimeout(idleTimer) },
        );
      } catch (err) {
        if (idleTimer) clearTimeout(idleTimer);
        if (err instanceof Error && err.name === "AbortError") {
          throw new ApiError(
            408,
            "timeout",
            `Stream stalled for ${IDLE_MS / 1000}s with no progress.`,
          );
        }
        throw err;
      }

      if (res.status === 401 && config.apiKey) {
        if (idleTimer) clearTimeout(idleTimer);
        clearConfig();
        throw new ApiError(
          401,
          "auth_expired",
          'Your API key is no longer valid. It may have been revoked.\nRun "opendocs login" to re-authenticate with a new key.',
        );
      }

      if (!res.ok) {
        if (idleTimer) clearTimeout(idleTimer);
        throw await apiErrorFromResponse(res);
      }

      try {
        for await (const { event, data } of parseSSE(res)) {
          resetIdle();
          if (event === "result") {
            yield { type: "result", data: JSON.parse(data) as BatchPublishResult };
          } else if (event === "summary") {
            yield { type: "summary", data: JSON.parse(data) as BatchPublishSummary };
          }
        }
      } finally {
        if (idleTimer) clearTimeout(idleTimer);
      }
    },

    // `postId` here is the raw user-typed value (UUID or slug). When `opts`
    // carries `workspaceId` it's appended as a query string so the server
    // can disambiguate slugs that exist in multiple workspaces the caller
    // has authored in — slugs are only unique per workspace. UUIDs ignore
    // the scope since they're globally unique. The CLI passes the active
    // workspace automatically (from config.json); omit for legacy scripts
    // that don't track an active workspace.
    update(
      postId: string,
      body: {
        markdown: string;
        title?: string;
        slug?: string;
        visibility?: string;
        workspaceId: string;
        projectId?: string;
        tags?: string[];
        sourcePath?: string;
        confirmPublic?: boolean;
        baseVersionNumber?: number;
      },
      opts?: { workspaceId?: string; projectId?: string },
    ) {
      const qs = postScopeQuery(opts);
      return request<{
        postId: string;
        versionId: string;
        versionNumber: number;
        unchanged?: boolean;
        slug: string;
        url?: string;
        title: string;
        visibility: string;
        projectSlug?: string;
        isDefaultProject?: boolean;
      }>("POST", `/api/v1/posts/${encodeURIComponent(postId)}/update${qs}`, body);
    },

    // ── Version history ─────────────────────────────────────────────────
    listVersions(postId: string, opts?: { workspaceId?: string; projectId?: string }) {
      const qs = postScopeQuery(opts);
      return request<{
        postId: string;
        versions: Array<{
          id: string;
          versionNumber: number;
          createdAt: string;
          createdBy: string | null;
          client: string | null;
          restoredFromVersion: number | null;
          bytes: number;
          isCurrent: boolean;
        }>;
      }>("GET", `/api/v1/posts/${encodeURIComponent(postId)}/versions${qs}`);
    },

    getVersionMarkdown(
      postId: string,
      versionNumber: number,
      opts?: { workspaceId?: string; projectId?: string },
    ) {
      const qs = postScopeQuery(opts);
      return request<{ postId: string; versionNumber: number; createdAt: string; markdown: string }>(
        "GET",
        `/api/v1/posts/${encodeURIComponent(postId)}/versions/${versionNumber}/raw${qs}`,
      );
    },

    restoreVersion(
      postId: string,
      versionNumber: number,
      opts?: { workspaceId?: string; projectId?: string },
    ) {
      const qs = postScopeQuery(opts);
      return request<{
        postId: string;
        versionId: string;
        versionNumber: number;
        restoredFromVersion: number;
        title: string;
      }>("POST", `/api/v1/posts/${encodeURIComponent(postId)}/versions/${versionNumber}/restore${qs}`);
    },

    // ── Projects & sharing ──────────────────────────────────────────────
    movePost(
      postId: string,
      target: { projectId?: string; projectSlug?: string },
      opts?: { workspaceId?: string; projectId?: string },
    ) {
      const qs = postScopeQuery(opts);
      return request<{
        postId: string;
        moved: boolean;
        slug: string;
        previousSlug?: string;
        url: string;
        projectId: string;
        projectSlug: string;
        projectName: string;
      }>("POST", `/api/v1/posts/${encodeURIComponent(postId)}/move${qs}`, target);
    },

    getShares(postId: string, opts?: { workspaceId?: string; projectId?: string }) {
      const qs = postScopeQuery(opts);
      return request<{ postId: string; emails: string[]; domains: string[] }>(
        "GET",
        `/api/v1/posts/${encodeURIComponent(postId)}/share${qs}`,
      );
    },

    addShares(
      postId: string,
      body: { emails: string[]; domains: string[]; notify?: boolean },
      opts?: { workspaceId?: string; projectId?: string },
    ) {
      const qs = postScopeQuery(opts);
      return request<{
        postId: string;
        emails: string[];
        domains: string[];
        added: { emails: string[]; domains: string[] };
        notified: string[];
        url: string;
      }>("POST", `/api/v1/posts/${encodeURIComponent(postId)}/share${qs}`, body);
    },

    removeShares(
      postId: string,
      body: { emails: string[]; domains: string[] },
      opts?: { workspaceId?: string; projectId?: string },
    ) {
      const qs = postScopeQuery(opts);
      return request<{ postId: string; emails: string[]; domains: string[] }>(
        "DELETE",
        `/api/v1/posts/${encodeURIComponent(postId)}/share${qs}`,
        body,
      );
    },

    // ── Workspaces & team ───────────────────────────────────────────────
    createWorkspace(body: { name: string; slug?: string }) {
      return request<{
        workspace: { id: string; name: string; slug: string; role: string };
        defaultProject: { id: string; name: string; slug: string } | null;
      }>("POST", "/api/v1/workspaces", body);
    },

    inviteMember(body: { email: string; role: "admin" | "member"; workspaceId: string }) {
      return request<{ invitation?: { id: string; email: string; role: string } } & Record<string, unknown>>(
        "POST",
        "/api/v1/workspace/team/invite",
        body,
      );
    },

    listMembers(workspaceId: string) {
      const qs = new URLSearchParams({ workspaceId });
      return request<{
        members: Array<{
          id?: string;
          userId?: string;
          name?: string | null;
          email?: string;
          username?: string | null;
          role: string;
          status?: string;
        }>;
      }>("GET", `/api/v1/workspace/team?${qs.toString()}`);
    },

    listInvitations(workspaceId: string) {
      const qs = new URLSearchParams({ workspaceId });
      return request<{
        invitations: Array<{ id: string; email: string; role: string; invitedAt: string; invitedByName: string | null }>;
      }>("GET", `/api/v1/workspace/team/invitations?${qs.toString()}`);
    },

    revokeInvitation(invitationId: string) {
      return request<{ success: true }>(
        "DELETE",
        `/api/v1/workspace/team/invitations/${encodeURIComponent(invitationId)}`,
      );
    },

    resendInvitation(invitationId: string) {
      return request<Record<string, unknown>>(
        "POST",
        `/api/v1/workspace/team/invitations/${encodeURIComponent(invitationId)}/resend`,
      );
    },

    changeMemberRole(membershipId: string, role: "admin" | "member") {
      return request<Record<string, unknown>>(
        "PATCH",
        `/api/v1/workspace/team/members/${encodeURIComponent(membershipId)}/role`,
        { role },
      );
    },

    removeMember(membershipId: string) {
      return request<{ success: true }>(
        "DELETE",
        `/api/v1/workspace/team/members/${encodeURIComponent(membershipId)}`,
      );
    },

    myInvitations() {
      return request<{
        emailVerified: boolean;
        invitations: Array<{
          id: string;
          workspaceId: string;
          workspaceName: string;
          workspaceSlug: string;
          role: string;
          invitedByName: string | null;
          expiresAt: string;
        }>;
        joinable: Array<{ workspaceId: string; workspaceName: string; workspaceSlug: string; domain: string }>;
      }>("GET", "/api/v1/me/invitations");
    },

    acceptInvitation(invitationId: string) {
      return request<{
        workspace: { id: string; name: string; slug: string };
        role: string;
        alreadyMember: boolean;
      }>("POST", `/api/v1/invitations/${encodeURIComponent(invitationId)}/accept`);
    },

    declineInvitation(invitationId: string) {
      return request<{ success: true; workspaceSlug: string }>(
        "POST",
        `/api/v1/invitations/${encodeURIComponent(invitationId)}/decline`,
      );
    },

    joinWorkspace(workspaceIdOrSlug: string) {
      return request<{
        workspace: { id: string; name: string; slug: string };
        role: string;
        alreadyMember: boolean;
      }>("POST", `/api/v1/workspaces/${encodeURIComponent(workspaceIdOrSlug)}/join`);
    },

    leaveWorkspace(workspaceId: string) {
      return request<{
        success: true;
        remainingWorkspaces: Array<{ id: string; slug: string; name: string }>;
      }>("POST", "/api/v1/workspace/leave", { workspaceId });
    },

    // ── Export branding (PDF / DOCX theme) ─────────────────────────────

    getBranding(workspaceId: string) {
      const qs = new URLSearchParams({ workspaceId });
      return request<WorkspaceBranding>("GET", `/api/v1/workspace/branding?${qs.toString()}`);
    },

    updateBranding(workspaceId: string, update: BrandingUpdate) {
      return request<WorkspaceBranding>("PATCH", "/api/v1/workspace/branding", {
        workspaceId,
        ...update,
      });
    },

    // Multipart upload; the API stores the image and sets it as the
    // workspace logo (shown on the profile and, when enabled, in exports).
    async uploadLogo(workspaceId: string, file: Buffer, filename: string, contentType: string) {
      const form = new FormData();
      form.append("workspaceId", workspaceId);
      form.append("file", new Blob([new Uint8Array(file)], { type: contentType }), filename);
      const headers: Record<string, string> = requestHeaders(config.apiKey);
      delete headers["Content-Type"];
      const res = await fetch(`${baseUrl}/api/v1/workspace/logo/upload`, {
        method: "POST",
        headers,
        body: form,
      });
      if (!res.ok) throw await apiErrorFromResponse(res);
      return (await res.json()) as { logoUrl: string };
    },

    removeLogo(workspaceId: string) {
      return request<{ logoUrl: null }>("POST", "/api/v1/workspace/logo", {
        workspaceId,
        logoUrl: null,
      });
    },

    autoJoinDomains(workspaceId: string) {
      const qs = new URLSearchParams({ workspaceId });
      return request<{ domains: Array<{ domain: string; createdAt: string }> }>(
        "GET",
        `/api/v1/workspace/auto-join?${qs.toString()}`,
      );
    },

    addAutoJoinDomain(workspaceId: string, domain: string) {
      return request<{ domains: Array<{ domain: string; createdAt: string }> }>(
        "POST",
        "/api/v1/workspace/auto-join",
        { workspaceId, domain },
      );
    },

    removeAutoJoinDomain(workspaceId: string, domain: string) {
      return request<{ domains: Array<{ domain: string; createdAt: string }> }>(
        "DELETE",
        "/api/v1/workspace/auto-join",
        { workspaceId, domain },
      );
    },

    // ── Accountless flows (no API key needed) ───────────────────────────
    requestSignInCode(email: string) {
      return request<{
        success: boolean;
        email: string;
        accountExists: boolean;
        expiresInSeconds: number;
        message: string;
      }>("POST", "/api/v1/auth/code/request", { email });
    },

    verifySignInCode(body: { email: string; code: string; keyName?: string }) {
      return request<{
        apiKey: string;
        keyName: string;
        accountCreated: boolean;
        userId: string;
        email: string;
        username: string;
        workspace: { id: string; slug: string; name: string };
        defaultProject: { id: string; slug: string; name: string } | null;
      }>("POST", "/api/v1/auth/code/verify", body);
    },

    publishAnonymous(body: { markdown: string; title?: string }) {
      return request<{
        id: string;
        title: string;
        url: string;
        claimToken: string;
        claimUrl: string;
        expiresAt: string;
        anonymous: true;
        message: string;
      }>("POST", "/api/v1/anonymous/publish", body);
    },

    updateAnonymous(id: string, body: { markdown: string; title?: string; claimToken: string }) {
      return request<{ id: string; title: string; url: string; expiresAt: string; anonymous: true }>(
        "PUT",
        `/api/v1/anonymous/${encodeURIComponent(id)}`,
        body,
      );
    },

    claimAnonymous(body: {
      claimToken: string;
      workspaceId: string;
      projectId?: string;
      visibility?: string;
      confirmPublic?: boolean;
    }) {
      return request<{
        postId: string;
        slug: string;
        url: string;
        title: string;
        versionNumber: number;
        claimedFrom: string;
        projectSlug: string;
      }>("POST", "/api/v1/anonymous/claim", body);
    },

    unpublish(postId: string, opts?: { workspaceId?: string; projectId?: string }) {
      const qs = postScopeQuery(opts);
      return request<{ postId: string; unpublished: boolean }>(
        "POST",
        `/api/v1/posts/${encodeURIComponent(postId)}/unpublish${qs}`,
      );
    },

    // Change a post's visibility without re-uploading its Markdown. The
    // server endpoint ignores `confirmPublic` unless the new level is
    // `public`, but we always send it explicitly to make the client call
    // self-describing.
    changeVisibility(
      postId: string,
      visibility: "private" | "workspace" | "public",
      opts?: { workspaceId?: string; projectId?: string; confirmPublic?: boolean },
    ) {
      const qs = postScopeQuery(opts);
      return request<{ postId: string; visibility: string }>(
        "POST",
        `/api/v1/posts/${encodeURIComponent(postId)}/visibility${qs}`,
        { visibility, confirmPublic: opts?.confirmPublic ?? false },
      );
    },

    // Hard-delete a post. Irreversible. The server returns the freed slug
    // so callers can surface "the slug is now free to reuse" without a
    // follow-up read — that's especially useful after the immediate
    // response in a chained script.
    deletePost(postId: string, opts?: { workspaceId?: string; projectId?: string }) {
      const qs = postScopeQuery(opts);
      return request<{ postId: string; deleted: true; slug: string }>(
        "DELETE",
        `/api/v1/posts/${encodeURIComponent(postId)}${qs}`,
      );
    },

    listPosts(opts?: {
      page?: number;
      limit?: number;
      tag?: string;
      // Scope results to a single workspace. Omit to list posts across
      // every workspace the caller has authored in (used by `list --all`).
      workspaceId?: string;
      projectId?: string;
    }) {
      const params = new URLSearchParams();
      if (opts?.page) params.set("page", String(opts.page));
      if (opts?.limit) params.set("limit", String(opts.limit));
      if (opts?.tag) params.set("tag", opts.tag);
      if (opts?.workspaceId) params.set("workspaceId", opts.workspaceId);
      if (opts?.projectId) params.set("projectId", opts.projectId);
      const qs = params.toString();
      return request<{
        posts: Array<{
          id: string;
          slug: string;
          title: string;
          summary: string | null;
          visibility: string;
          isPublished: boolean;
          updatedAt: string;
          tags: string[];
          workspaceId: string;
          workspaceSlug: string;
          projectId: string;
          projectSlug: string;
          projectName: string;
          isDefaultProject: boolean;
          versionNumber: number | null;
        }>;
        pagination: {
          page: number;
          limit: number;
          total: number;
          totalPages: number;
        };
      }>("GET", `/api/v1/posts${qs ? `?${qs}` : ""}`);
    },

    getPost(postId: string, opts?: { workspaceId?: string; projectId?: string }) {
      const qs = postScopeQuery(opts);
      return request<{
        post: {
          id: string;
          slug: string;
          title: string;
          summary: string | null;
          visibility: string;
          isPublished: boolean;
          publishedAt: string;
          updatedAt: string;
          url: string;
          versionNumber: number;
          tags: string[];
          projectId: string;
          projectSlug: string;
          projectName: string;
          isDefaultProject: boolean;
        };
      }>("GET", `/api/v1/posts/${encodeURIComponent(postId)}${qs}`);
    },

    pullPost(postId: string, opts?: { workspaceId?: string; projectId?: string }) {
      const qs = postScopeQuery(opts);
      return request<{
        postId: string;
        markdown: string;
        title: string;
        slug: string;
        projectId: string;
        projectSlug: string;
        projectName: string;
        isDefaultProject: boolean;
        versionNumber: number;
      }>("GET", `/api/v1/posts/${encodeURIComponent(postId)}/raw${qs}`);
    },

    exportPost(
      postId: string,
      format: "docx" | "pdf",
      body?: {
        filename?: string;
        landscape?: boolean;
        accent_color?: string;
        branding?: Record<string, unknown>;
      },
      opts?: { workspaceId?: string; projectId?: string },
    ) {
      const qs = postScopeQuery(opts);
      return requestBinary(
        "POST",
        `/api/v1/posts/${encodeURIComponent(postId)}/export/${format}${qs}`,
        body ?? {},
      );
    },

    // Ask the API for a presigned PUT URL on the object store. Used during
     // publish to upload local inline images before rewriting the Markdown
     // to point at the returned publicUrl.
    presignImageUpload(body: {
      workspaceId: string;
      contentType: string;
      contentLength: number;
      filename?: string;
    }) {
      return request<{
        uploadUrl: string;
        publicUrl: string;
        key: string;
        expiresInSeconds: number;
        maxBytes?: number;
      }>("POST", "/api/v1/storage/images/presign-upload", body);
    },

    // Direct PUT to the presigned URL. Not an API call — we're talking to
    // R2 directly. Intentionally skips the Authorization header; the URL
    // itself carries the credentials.
    async uploadToSignedUrl(
      uploadUrl: string,
      body: Buffer | Uint8Array,
      contentType: string,
    ): Promise<void> {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 60_000);
      try {
        // Node's fetch typings (lib.dom) don't list Buffer/Uint8Array as a
        // valid BodyInit, but undici accepts both at runtime. Cast through
        // unknown to satisfy the compiler without copying the bytes.
        const res = await fetch(uploadUrl, {
          method: "PUT",
          headers: {
            "Content-Type": contentType,
            "Content-Length": String(body.byteLength),
          },
          body: body as unknown as BodyInit,
          signal: controller.signal,
        });
        if (!res.ok) {
          throw new ApiError(
            res.status,
            "upload_failed",
            `Storage upload failed with status ${res.status}`,
          );
        }
      } catch (err) {
        if (err instanceof Error && err.name === "AbortError") {
          throw new ApiError(
            408,
            "timeout",
            "Image upload timed out after 60s.",
          );
        }
        throw err;
      } finally {
        clearTimeout(timeout);
      }
    },

    // Batch export: sends N postIds, gets back a zip + a manifest.
    // Manifest is attached both inside the zip (as manifest.json) and on
    // the X-Batch-Manifest response header (base64 JSON) so callers can
    // render per-doc progress before unpacking the zip.
    //
    // The server converts the documents one after another and gives each up
    // to 55s at the converter, so allow a minute per document. Long legal or
    // report-style documents under load need the room; most batches of 10
    // finish in under 30s.
    async batchExportPosts(body: {
      postIds: string[];
      format: "docx" | "pdf";
      landscape?: boolean;
      accent_color?: string;
      branding?: Record<string, unknown>;
      // Optional active-workspace scope. Sent inside the JSON body (not the
      // query string) because the batch endpoint is POST-with-body already
      // and this keeps every batch input together. Slugs passed in
      // `postIds` are disambiguated to this workspace server-side; UUIDs
      // ignore it.
      workspaceId?: string;
      projectId?: string;
    }): Promise<{
      buffer: Buffer;
      filename: string;
      contentType: string;
      manifest: BatchExportManifest | null;
    }> {
      const { buffer, filename, contentType, headers } = await requestBinary(
        "POST",
        "/api/v1/posts/batch/export",
        body,
        { timeoutMs: body.postIds.length * 60_000 + 30_000 },
      );
      const manifestB64 = headers.get("x-batch-manifest");
      const manifest = manifestB64
        ? (JSON.parse(
            Buffer.from(manifestB64, "base64").toString("utf8"),
          ) as BatchExportManifest)
        : null;
      return { buffer, filename, contentType, manifest };
    },

    // ── Integrations: Google Drive storage + DocuSeal signatures ────────
    // Workspace-scoped, Pro/Team only (`plan_required` on Free). GETs and
    // DELETEs carry `workspaceId` in the query, POSTs in the body.

    getIntegrations(workspaceId: string) {
      const qs = new URLSearchParams({ workspaceId });
      return request<IntegrationsOverview>("GET", `/api/v1/integrations?${qs.toString()}`);
    },

    // Renders the document and uploads it to a named Drive folder. Export +
    // upload can take a while for long documents, hence the longer timeout.
    saveToStorage(
      postId: string,
      body: {
        workspaceId?: string;
        destination: string;
        format?: StorageFormat;
        versionNumber?: number;
        filename?: string;
      },
    ) {
      return request<StorageRun>(
        "POST",
        `/api/v1/posts/${encodeURIComponent(postId)}/storage`,
        body,
        { timeoutMs: 120_000 },
      );
    },

    // Creates a DRAFT. Nothing is emailed until sendSignatureRequest().
    createSignatureRequest(postId: string, body: CreateSignatureRequestBody) {
      return request<SignatureRequest>(
        "POST",
        `/api/v1/posts/${encodeURIComponent(postId)}/signature-requests`,
        body,
        { timeoutMs: 90_000 },
      );
    },

    sendSignatureRequest(id: string, opts?: { workspaceId?: string }) {
      return request<SignatureRequest>(
        "POST",
        `/api/v1/signature-requests/${encodeURIComponent(id)}/send`,
        { confirm: true, ...(opts?.workspaceId ? { workspaceId: opts.workspaceId } : {}) },
        { timeoutMs: 60_000 },
      );
    },

    listSignatureRequests(opts: { workspaceId: string; postId?: string; status?: SignatureRequestStatus }) {
      const params = new URLSearchParams({ workspaceId: opts.workspaceId });
      if (opts.postId) params.set("postId", opts.postId);
      if (opts.status) params.set("status", opts.status);
      return request<{ requests: SignatureRequest[] }>(
        "GET",
        `/api/v1/signature-requests?${params.toString()}`,
      );
    },

    getSignatureRequest(id: string, opts?: { workspaceId?: string }) {
      const qs = postScopeQuery(opts);
      return request<SignatureRequest>(
        "GET",
        `/api/v1/signature-requests/${encodeURIComponent(id)}${qs}`,
      );
    },

    cancelSignatureRequest(id: string, opts?: { workspaceId?: string }) {
      const qs = postScopeQuery(opts);
      return request<SignatureRequest>(
        "DELETE",
        `/api/v1/signature-requests/${encodeURIComponent(id)}${qs}`,
      );
    },

    // Draft preview (`draft`), signed PDF (`signed`) or signing certificate (`audit`).
    // `filename` is null when the server sent no Content-Disposition name.
    async downloadSignatureDocument(
      id: string,
      kind: SignatureDocumentKind,
      opts?: { workspaceId?: string },
    ): Promise<{ buffer: Buffer; filename: string | null; contentType: string }> {
      const qs = postScopeQuery(opts);
      const { buffer, contentType, headers } = await requestBinary(
        "GET",
        `/api/v1/signature-requests/${encodeURIComponent(id)}/documents/${kind}${qs}`,
      );
      return {
        buffer,
        filename: filenameFromDisposition(headers.get("content-disposition")),
        contentType,
      };
    },

    saveSignatureRequestToStorage(id: string, body: { destination: string; workspaceId?: string }) {
      return request<{
        destination: { id: string; name: string };
        files: Array<StoredFile & { kind: "signed" | "audit" }>;
      }>(
        "POST",
        `/api/v1/signature-requests/${encodeURIComponent(id)}/storage`,
        body,
        { timeoutMs: 120_000 },
      );
    },
  };
}
