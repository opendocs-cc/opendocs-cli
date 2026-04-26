import { Command } from "commander";
import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import readline from "node:readline";
import { saveConfig } from "../lib/config.js";
import { createApiClient } from "../lib/api.js";
import { createOutput, brand } from "../lib/output.js";
import { CLI_VERSION } from "../lib/version.js";

const BROWSER_LOGIN_TIMEOUT_MS = 10 * 60 * 1000;
const BROWSER_LOGIN_TIMEOUT_MINUTES = Math.round(BROWSER_LOGIN_TIMEOUT_MS / 60_000);

export const loginCommand = new Command("login")
  .description("Authenticate with OpenDocs")
  .option("--key <key>", "API key (or set OPENDOCS_API_KEY env var)")
  .option("--browser", "Open a browser and authorize the CLI from your OpenDocs account")
  .option("--web-url <url>", "Web app URL for browser login")
  .action(async (opts, cmd) => {
    const globalOpts = cmd.optsWithGlobals();
    const out = createOutput(globalOpts.json);
    const apiUrl =
      globalOpts.apiUrl ||
      process.env.OPENDOCS_API_URL ||
      "https://api.opendocs.cc";
    const webUrl =
      opts.webUrl ||
      process.env.OPENDOCS_WEB_URL ||
      deriveWebUrl(apiUrl);

    try {
      // Resolve API key: flag > env > interactive prompt
      let apiKey: string = opts.key || process.env.OPENDOCS_API_KEY || "";

      if (!apiKey && opts.browser) {
        apiKey = await loginWithBrowser({ apiUrl, webUrl, out });
      }

      if (!apiKey && !opts.browser) {
        apiKey = await promptForKey();
      }

      if (!apiKey) {
        out.error({ message: "No API key provided." });
        return;
      }

      if (!apiKey.startsWith("od_live_")) {
        out.error({
          code: "invalid_key_format",
          message: 'Invalid API key format. Keys start with "od_live_".',
        });
        return;
      }

      out.spin("Validating API key with OpenDocs...");

      const client = createApiClient({ apiKey, apiUrl });
      const data = await client.me();

      if (!data.onboarding?.username || !data.onboarding?.workspace) {
        out.fail("Onboarding incomplete");
        out.error({
          code: "onboarding_incomplete",
          message:
            "Complete onboarding on the OpenDocs web app before using the CLI.",
        });
        return;
      }

      const defaultProject = data.onboarding.workspace.defaultProject;

      saveConfig({
        apiKey,
        apiUrl,
        userId: data.userId,
        username: data.onboarding.username,
        workspaceId: data.onboarding.workspace.id,
        workspaceName: data.onboarding.workspace.name,
        workspaceSlug: data.onboarding.workspace.slug,
        projectId: defaultProject?.id,
        projectName: defaultProject?.name,
        projectSlug: defaultProject?.slug,
      });

      out.succeed(
        `Logged in as ${brand.purpleBold(data.onboarding.username)} ${brand.muted("·")} workspace: ${brand.value(data.onboarding.workspace.name)}${
          defaultProject
            ? ` ${brand.muted("·")} project: ${brand.value(defaultProject.name)}`
            : ""
        }`,
      );

      // Multi-workspace hint — best-effort. If the user belongs to more
      // than one workspace, let them know how to see the full list and
      // switch. Failures here are non-fatal; login already succeeded.
      try {
        const { workspaces } = await client.listWorkspaces();
        if (workspaces.length > 1) {
          out.info(
            brand.muted(
              `You belong to ${workspaces.length} workspaces. Run ${brand.purple("opendocs workspace list")} to see them all.`,
            ),
          );
        }
      } catch {
        // Swallow — this is a hint, not a requirement.
      }

      out.result({
        success: true,
        username: data.onboarding.username,
        workspaceId: data.onboarding.workspace.id,
        projectId: defaultProject?.id,
      });
    } catch (err: unknown) {
      const error = err as { status?: number; code?: string; message: string };
      out.error(error);
    }
  });

function deriveWebUrl(apiUrl: string): string {
  const parsed = new URL(apiUrl);
  if (parsed.hostname === "api.opendocs.cc") {
    return "https://opendocs.cc";
  }
  if (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1") {
    return `${parsed.protocol}//${parsed.hostname}:3000`;
  }
  if (parsed.hostname.startsWith("api.")) {
    parsed.hostname = parsed.hostname.slice(4);
    return `${parsed.protocol}//${parsed.host}`;
  }
  return `${parsed.protocol}//${parsed.host}`;
}

function randomToken(): string {
  return randomBytes(32).toString("base64url");
}

function codeChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

async function loginWithBrowser({
  apiUrl,
  webUrl,
  out,
}: {
  apiUrl: string;
  webUrl: string;
  out: ReturnType<typeof createOutput>;
}): Promise<string> {
  const state = randomToken();
  const verifier = randomToken();
  const challenge = codeChallenge(verifier);
  const callback = await createCallbackServer(state);

  try {
    const startRes = await fetch(`${webUrl.replace(/\/$/, "")}/api/cli-auth/start`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": `opendocs-cli/${CLI_VERSION}`,
      },
      body: JSON.stringify({
        state,
        codeChallenge: challenge,
        redirectUri: callback.redirectUri,
        apiUrl,
        clientName: `OpenDocs CLI ${CLI_VERSION}`,
      }),
    });

    const startPayload = (await startRes.json().catch(() => ({}))) as {
      authorizeUrl?: string;
      message?: string;
    };
    if (!startRes.ok || !startPayload.authorizeUrl) {
      throw new Error(startPayload.message || "Could not start browser login.");
    }

    out.info(`Opening ${brand.url(startPayload.authorizeUrl)}`);
    out.info(
      brand.muted(
        `Confirm the account and workspace in your browser. This login expires in ${BROWSER_LOGIN_TIMEOUT_MINUTES} minutes.`,
      ),
    );
    await openBrowser(startPayload.authorizeUrl);

    out.spin("Waiting for browser authorization...");
    const code = await callback.waitForCode();
    out.spin("Completing CLI login...");

    const exchangeRes = await fetch(`${webUrl.replace(/\/$/, "")}/api/cli-auth/exchange`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": `opendocs-cli/${CLI_VERSION}`,
      },
      body: JSON.stringify({ code, codeVerifier: verifier }),
    });
    const exchangePayload = (await exchangeRes.json().catch(() => ({}))) as {
      apiKey?: string;
      message?: string;
    };
    if (!exchangeRes.ok || !exchangePayload.apiKey) {
      throw new Error(exchangePayload.message || "Could not complete browser login.");
    }

    return exchangePayload.apiKey;
  } finally {
    callback.close();
  }
}

async function createCallbackServer(expectedState: string): Promise<{
  redirectUri: string;
  waitForCode: () => Promise<string>;
  close: () => void;
}> {
  let resolveCode!: (code: string) => void;
  let rejectCode!: (err: Error) => void;
  const codePromise = new Promise<string>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== "/callback") {
      res.writeHead(404).end("Not found");
      return;
    }

    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    if (!code || state !== expectedState) {
      res
        .writeHead(400, { "Content-Type": "text/html; charset=utf-8" })
        .end("<h1>OpenDocs CLI login failed</h1><p>Return to your terminal and try again.</p>");
      rejectCode(new Error("Browser login returned an invalid response."));
      return;
    }

    res
      .writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
      .end(
        "<h1>OpenDocs CLI login complete</h1><p>You can close this tab and return to your terminal.</p>",
      );
    resolveCode(code);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Could not start local browser login callback server.");
  }

  const timeout = setTimeout(() => {
    rejectCode(
      new Error(
        `Browser login timed out after ${BROWSER_LOGIN_TIMEOUT_MINUTES} minutes. Run opendocs login --browser again.`,
      ),
    );
  }, BROWSER_LOGIN_TIMEOUT_MS);

  return {
    redirectUri: `http://127.0.0.1:${address.port}/callback`,
    waitForCode: async () => {
      try {
        return await codePromise;
      } finally {
        clearTimeout(timeout);
      }
    },
    close: () => {
      clearTimeout(timeout);
      server.close();
    },
  };
}

function openBrowser(url: string): Promise<void> {
  const command =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "cmd"
        : "xdg-open";
  const args =
    process.platform === "win32"
      ? ["/c", "start", "", url]
      : [url];

  return new Promise((resolve) => {
    const child = spawn(command, args, {
      detached: true,
      stdio: "ignore",
    });
    child.on("error", () => {
      resolve();
    });
    child.unref();
    resolve();
  });
}

function promptForKey(): Promise<string> {
  if (!process.stdin.isTTY) {
    return new Promise((resolve) => {
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
      });
      rl.question("Enter your API key: ", (answer) => {
        rl.close();
        resolve(answer.trim());
      });
    });
  }

  return new Promise((resolve) => {
    const stdin = process.stdin;
    const wasRaw = stdin.isRaw;
    let value = "";
    let done = false;

    process.stdout.write("Enter your API key: ");
    stdin.setEncoding("utf8");
    stdin.setRawMode(true);
    stdin.resume();

    const cleanup = () => {
      stdin.off("data", onData);
      stdin.off("end", onEnd);
      process.off("SIGINT", onSigint);
      stdin.setRawMode(wasRaw);
      stdin.pause();
    };

    const finish = (answer: string) => {
      if (done) return;
      done = true;
      cleanup();
      process.stdout.write("\n");
      resolve(answer.trim());
    };

    const onSigint = () => {
      if (done) return;
      done = true;
      cleanup();
      process.stdout.write("\n");
      process.exit(130);
    };

    const onData = (chunk: string) => {
      for (const char of chunk) {
        if (char === "\u0003") {
          onSigint();
          return;
        }
        if (char === "\r" || char === "\n") {
          finish(value);
          return;
        }
        if (char === "\u007f" || char === "\b") {
          value = value.slice(0, -1);
          continue;
        }
        value += char;
      }
    };

    const onEnd = () => {
      finish(value);
    };

    stdin.on("data", onData);
    stdin.once("end", onEnd);
    process.once("SIGINT", onSigint);
  });
}
