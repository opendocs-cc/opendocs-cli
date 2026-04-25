import { clearConfig, type CliConfig } from "./config.js";
import { CLI_VERSION } from "./version.js";

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
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
function postScopeQuery(opts?: { workspaceId?: string }): string {
  if (!opts?.workspaceId) return "";
  const params = new URLSearchParams({ workspaceId: opts.workspaceId });
  return `?${params.toString()}`;
}

export function createApiClient(config: CliConfig) {
  const baseUrl = config.apiUrl.replace(/\/$/, "");

  async function request<T>(
    method: string,
    path: string,
    body?: unknown,
    opts?: { timeoutMs?: number },
  ): Promise<T> {
    // Default 30s — most calls finish in <1s. Batch publish overrides to 90s
    // since it can run up to 25 DB transactions sequentially server-side.
    const timeoutMs = opts?.timeoutMs ?? 30_000;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    let res: Response;
    try {
      res = await fetch(`${baseUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          "Content-Type": "application/json",
          "User-Agent": `opendocs-cli/${CLI_VERSION}`,
        },
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

    if (res.status === 401) {
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
      const data = (await res
        .json()
        .catch(() => ({}))) as { error?: string; message?: string };
      throw new ApiError(
        res.status,
        data.error || "api_error",
        data.message || `Request failed with status ${res.status}`,
      );
    }

    const data = await res.json();
    return data as T;
  }

  // Sibling of request() for endpoints that return binary file downloads
  // (e.g. /export/docx, /export/pdf). The API side sets Content-Disposition
  // with a suggested filename — we parse it so callers can save under that
  // name by default.
  //
  // Accepts a timeout override — batch export can take up to ~40s for 10 PDFs
  // so the caller needs room to wait.
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
    const timeoutMs = opts?.timeoutMs ?? 60_000;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    let res: Response;
    try {
      res = await fetch(`${baseUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          "Content-Type": "application/json",
          "User-Agent": `opendocs-cli/${CLI_VERSION}`,
        },
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

    if (res.status === 401) {
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
      const data = (await res
        .json()
        .catch(() => ({}))) as { error?: string; message?: string };
      throw new ApiError(
        res.status,
        data.error || "api_error",
        data.message || `Request failed with status ${res.status}`,
      );
    }

    const buffer = Buffer.from(await res.arrayBuffer());
    const disp = res.headers.get("content-disposition") ?? "";
    const match = /filename="([^"]+)"/.exec(disp);
    const filename = match?.[1] ?? "document";
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
          workspace?: { id: string; name: string; slug: string };
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

    publish(body: {
      markdown: string;
      title?: string;
      slug?: string;
      visibility: string;
      workspaceId: string;
      tags?: string[];
      sourcePath?: string;
      confirmPublic?: boolean;
    }) {
      return request<{
        postId: string;
        slug: string;
        url: string;
        title: string;
      }>("POST", "/api/v1/publish", body);
    },

    publishBatch(body: {
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
        res = await fetch(`${baseUrl}/api/v1/publish/batch`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${config.apiKey}`,
            "Content-Type": "application/json",
            "User-Agent": `opendocs-cli/${CLI_VERSION}`,
            Accept: "text/event-stream",
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
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

      if (res.status === 401) {
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
        const data = (await res
          .json()
          .catch(() => ({}))) as { error?: string; message?: string };
        throw new ApiError(
          res.status,
          data.error || "api_error",
          data.message || `Request failed with status ${res.status}`,
        );
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
        tags?: string[];
        sourcePath?: string;
        confirmPublic?: boolean;
      },
      opts?: { workspaceId?: string },
    ) {
      const qs = postScopeQuery(opts);
      return request<{
        postId: string;
        versionId: string;
        versionNumber: number;
        slug: string;
        title: string;
        visibility: string;
      }>("POST", `/api/v1/posts/${encodeURIComponent(postId)}/update${qs}`, body);
    },

    unpublish(postId: string, opts?: { workspaceId?: string }) {
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
      opts?: { workspaceId?: string; confirmPublic?: boolean },
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
    deletePost(postId: string, opts?: { workspaceId?: string }) {
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
    }) {
      const params = new URLSearchParams();
      if (opts?.page) params.set("page", String(opts.page));
      if (opts?.limit) params.set("limit", String(opts.limit));
      if (opts?.tag) params.set("tag", opts.tag);
      if (opts?.workspaceId) params.set("workspaceId", opts.workspaceId);
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
        }>;
        pagination: {
          page: number;
          limit: number;
          total: number;
          totalPages: number;
        };
      }>("GET", `/api/v1/posts${qs ? `?${qs}` : ""}`);
    },

    getPost(postId: string, opts?: { workspaceId?: string }) {
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
        };
      }>("GET", `/api/v1/posts/${encodeURIComponent(postId)}${qs}`);
    },

    pullPost(postId: string, opts?: { workspaceId?: string }) {
      const qs = postScopeQuery(opts);
      return request<{
        markdown: string;
        title: string;
        slug: string;
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
      opts?: { workspaceId?: string },
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
    // 120s timeout — server does up to MAX_BATCH_SIZE (10) × ~10s PDF
    // conversions sequentially. Generous ceiling with margin.
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
        { timeoutMs: 120_000 },
      );
      const manifestB64 = headers.get("x-batch-manifest");
      const manifest = manifestB64
        ? (JSON.parse(
            Buffer.from(manifestB64, "base64").toString("utf8"),
          ) as BatchExportManifest)
        : null;
      return { buffer, filename, contentType, manifest };
    },
  };
}
