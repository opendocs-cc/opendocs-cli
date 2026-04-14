import { clearConfig, type CliConfig } from "./config.js";

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

export function createApiClient(config: CliConfig) {
  const baseUrl = config.apiUrl.replace(/\/$/, "");

  async function request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
        "User-Agent": "opendocs-cli/0.1.0",
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    if (res.status === 401) {
      clearConfig();
      throw new ApiError(
        401,
        "auth_expired",
        'Your API key is no longer valid. It may have been revoked.\nRun "opendocs login" to re-authenticate with a new key.',
      );
    }

    const data = await res.json();

    if (!res.ok) {
      throw new ApiError(
        res.status,
        data.error ?? "api_error",
        data.message ?? `Request failed with status ${res.status}`,
      );
    }

    return data as T;
  }

  return {
    me() {
      return request<{
        authenticated: boolean;
        userId: string;
        onboarding: {
          username?: string;
          workspace?: { id: string; name: string };
        };
      }>("GET", "/api/v1/me");
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
    ) {
      return request<{
        postId: string;
        versionId: string;
        versionNumber: number;
        slug: string;
        title: string;
        visibility: string;
      }>("POST", `/api/v1/posts/${postId}/update`, body);
    },

    unpublish(postId: string) {
      return request<{ postId: string; unpublished: boolean }>(
        "POST",
        `/api/v1/posts/${postId}/unpublish`,
      );
    },

    listPosts(opts?: { page?: number; limit?: number; tag?: string }) {
      const params = new URLSearchParams();
      if (opts?.page) params.set("page", String(opts.page));
      if (opts?.limit) params.set("limit", String(opts.limit));
      if (opts?.tag) params.set("tag", opts.tag);
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
        }>;
        pagination: {
          page: number;
          limit: number;
          total: number;
          totalPages: number;
        };
      }>("GET", `/api/v1/posts${qs ? `?${qs}` : ""}`);
    },

    getPost(postId: string) {
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
      }>("GET", `/api/v1/posts/${postId}`);
    },

    pullPost(postId: string) {
      return request<{
        markdown: string;
        title: string;
        slug: string;
        versionNumber: number;
      }>("GET", `/api/v1/posts/${postId}/raw`);
    },
  };
}
