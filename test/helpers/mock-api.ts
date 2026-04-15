import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { URL } from "node:url";

/**
 * In-process stand-in for api.opendocs.cc. A test pins handlers per route,
 * runs a CLI subprocess with `OPENDOCS_API_URL=http://127.0.0.1:<port>`, and
 * asserts on the recorded request tape + the command's stdout/exit code.
 *
 * Handlers see a parsed route + already-consumed JSON body. For SSE responses,
 * set Content-Type to text/event-stream and write directly to the response —
 * the helper does not pre-serialize.
 *
 * Matching is literal for most routes and substitution-based for path params,
 * e.g. register "POST /api/v1/posts/:postId/export/:format" and the handler
 * receives `params = { postId: "abc", format: "pdf" }`.
 */

export type MockRequest = {
  method: string;
  url: string;
  headers: IncomingMessage["headers"];
  body: unknown;
  params: Record<string, string>;
  query: URLSearchParams;
};

export type MockHandler = (req: MockRequest, res: ServerResponse) => void | Promise<void>;

type Route = {
  method: string;
  pattern: RegExp;
  paramNames: string[];
  handler: MockHandler;
};

export type MockApi = {
  url: string;
  calls: MockRequest[];
  on: (method: string, path: string, handler: MockHandler) => void;
  reset: () => void;
  close: () => Promise<void>;
};

function compilePath(path: string): { pattern: RegExp; paramNames: string[] } {
  const paramNames: string[] = [];
  // Escape regex specials, then convert `:name` segments into capture groups.
  const escaped = path.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const patternSource = escaped.replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, (_, name: string) => {
    paramNames.push(name);
    return "([^/]+)";
  });
  return { pattern: new RegExp(`^${patternSource}$`), paramNames };
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

export async function startMockApi(): Promise<MockApi> {
  let routes: Route[] = [];
  const calls: MockRequest[] = [];

  const server: Server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const rawUrl = req.url ?? "/";
    // URL needs an absolute base; the host portion is discarded.
    const parsed = new URL(rawUrl, "http://localhost");
    const body = await readBody(req);

    for (const route of routes) {
      if (route.method !== req.method) continue;
      const match = route.pattern.exec(parsed.pathname);
      if (!match) continue;

      const params: Record<string, string> = {};
      route.paramNames.forEach((name, i) => {
        params[name] = decodeURIComponent(match[i + 1] ?? "");
      });

      const mockReq: MockRequest = {
        method: req.method!,
        url: rawUrl,
        headers: req.headers,
        body,
        params,
        query: parsed.searchParams,
      };
      calls.push(mockReq);

      try {
        await route.handler(mockReq, res);
      } catch (err) {
        // Surface handler errors so the test fails loudly instead of hanging.
        if (!res.headersSent) res.statusCode = 500;
        res.end(err instanceof Error ? err.message : "handler threw");
      }
      return;
    }

    // Unmatched route — record it and 404 so tests catch missing stubs.
    calls.push({
      method: req.method!,
      url: rawUrl,
      headers: req.headers,
      body,
      params: {},
      query: parsed.searchParams,
    });
    res.statusCode = 404;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "route_not_stubbed", message: `${req.method} ${parsed.pathname}` }));
  });

  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", rejectListen);
      resolveListen();
    });
  });

  const address = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${address.port}`;

  return {
    url,
    calls,
    on(method, path, handler) {
      const { pattern, paramNames } = compilePath(path);
      routes.push({ method: method.toUpperCase(), pattern, paramNames, handler });
    },
    reset() {
      routes = [];
      calls.length = 0;
    },
    close() {
      return new Promise<void>((resolveClose, rejectClose) => {
        server.close((err) => {
          if (err) rejectClose(err);
          else resolveClose();
        });
      });
    },
  };
}

/** Convenience: JSON response with a default 200 status. */
export function respondJson(res: ServerResponse, body: unknown, status = 200): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

/** Convenience: binary response with Content-Disposition filename. */
export function respondBinary(
  res: ServerResponse,
  body: Buffer,
  opts: { contentType: string; filename: string; extraHeaders?: Record<string, string> },
): void {
  res.statusCode = 200;
  res.setHeader("Content-Type", opts.contentType);
  res.setHeader("Content-Disposition", `attachment; filename="${opts.filename}"`);
  res.setHeader("Content-Length", String(body.length));
  if (opts.extraHeaders) {
    for (const [k, v] of Object.entries(opts.extraHeaders)) res.setHeader(k, v);
  }
  res.end(body);
}

/**
 * Write an SSE event to a streaming response. Caller is responsible for
 * setting the initial headers and calling `res.end()` when done.
 */
export function sseFrame(res: ServerResponse, event: string, data: unknown): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}
