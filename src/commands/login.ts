import { Command } from "commander";
import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import type { Socket } from "node:net";
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

function normalizeAuthorizeUrl(authorizeUrl: string, webUrl: string): string {
  const parsed = new URL(authorizeUrl);
  if (parsed.hostname !== "0.0.0.0" && parsed.hostname !== "::" && parsed.hostname !== "[::]") {
    return parsed.toString();
  }

  const publicWeb = new URL(webUrl);
  parsed.protocol = publicWeb.protocol;
  parsed.hostname = publicWeb.hostname;
  parsed.port = publicWeb.port;
  return parsed.toString();
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

    const authorizeUrl = normalizeAuthorizeUrl(startPayload.authorizeUrl, webUrl);
    out.info(`Opening ${brand.url(authorizeUrl)}`);
    out.info(
      brand.muted(
        `Confirm the account and workspace in your browser. This login expires in ${BROWSER_LOGIN_TIMEOUT_MINUTES} minutes. Press Ctrl+C to cancel.`,
      ),
    );
    await openBrowser(authorizeUrl);

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
  codePromise.catch(() => {});
  let settled = false;

  const resolveOnce = (code: string) => {
    if (settled) return;
    settled = true;
    resolveCode(code);
  };

  const rejectOnce = (err: Error) => {
    if (settled) return;
    settled = true;
    rejectCode(err);
  };

  const onSigint = () => {
    rejectOnce(new Error("Browser login cancelled."));
  };
  process.once("SIGINT", onSigint);

  const sockets = new Set<Socket>();
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== "/callback") {
      res.writeHead(404, { Connection: "close" }).end("Not found");
      return;
    }

    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    if (!code || state !== expectedState) {
      res
        .writeHead(400, {
          "Content-Type": "text/html; charset=utf-8",
          Connection: "close",
        })
        .end(callbackHtml("failed"));
      rejectOnce(new Error("Browser login returned an invalid response."));
      return;
    }

    res
      .writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        Connection: "close",
      })
      .end(callbackHtml("success"));
    resolveOnce(code);
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", (err) => {
      process.off("SIGINT", onSigint);
      reject(err);
    });
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Could not start local browser login callback server.");
  }

  const timeout = setTimeout(() => {
    rejectOnce(
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
        process.off("SIGINT", onSigint);
      }
    },
    close: () => {
      clearTimeout(timeout);
      process.off("SIGINT", onSigint);
      server.close();
      for (const socket of sockets) {
        socket.destroy();
      }
    },
  };
}

function callbackHtml(state: "success" | "failed"): string {
  const success = state === "success";
  const title = success ? "Authentication Successful" : "Authentication Failed";
  const message = success
    ? "You can close this tab and return to your terminal."
    : "Return to your terminal and run opendocs login --browser again.";
  const icon = success ? "✓" : "!";
  const accent = success ? "#12b76a" : "#ef4444";

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>OpenDocs CLI Login</title>
  <style>
    :root {
      color-scheme: light;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: #fafafa;
      color: #171717;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      display: grid;
      place-items: center;
      background:
        linear-gradient(90deg, #f97316, #c026d3) top / 100% 6px no-repeat,
        #fafafa;
    }
    main {
      width: min(92vw, 520px);
      text-align: center;
    }
    .brand {
      display: flex;
      justify-content: center;
      margin-bottom: 48px;
    }
    .brand svg {
      width: 250px;
      max-width: 72vw;
      height: auto;
      display: block;
    }
    .card {
      background: #fff;
      border: 1px solid #e5e5e5;
      border-radius: 8px;
      box-shadow: 0 22px 60px rgba(15, 23, 42, 0.16);
      padding: 48px 40px 42px;
    }
    .icon {
      width: 64px;
      height: 64px;
      display: inline-grid;
      place-items: center;
      border-radius: 16px;
      background: ${accent}1a;
      color: ${accent};
      font-size: 36px;
      font-weight: 800;
      margin-bottom: 24px;
    }
    h1 {
      margin: 0;
      font-size: 28px;
      line-height: 1.2;
      font-weight: 750;
      letter-spacing: 0;
    }
    p {
      margin: 16px 0 0;
      color: #525252;
      font-size: 17px;
      line-height: 1.6;
    }
  </style>
</head>
<body>
  <main>
    <div class="brand" aria-label="OpenDocs">${opendocsLogoSvg()}</div>
    <section class="card" aria-labelledby="title">
      <div class="icon" aria-hidden="true">${icon}</div>
      <h1 id="title">${title}</h1>
      <p>${message}</p>
    </section>
  </main>
</body>
</html>`;
}

function opendocsLogoSvg(): string {
  return `<svg width="250" height="40" viewBox="0 0 250 40" fill="none" xmlns="http://www.w3.org/2000/svg" role="img" aria-hidden="true">
<path d="M30.7422 1C34.1982 1.00019 36.9998 3.8018 37 7.25781V31.7422C36.9998 35.1982 34.1982 37.9998 30.7422 38H6.25781C2.8018 37.9998 0.000188746 35.1982 0 31.7422V7.25781C0.000188692 3.8018 2.8018 1.00019 6.25781 1H30.7422ZM4.41699 23.4893L3.62695 24.2178V25.3008L4.41699 26.0293H5.75781L6.5293 25.2842V24.2344L5.75781 23.4893H4.41699ZM8.34277 26.0283H10.7822V20.6748L12.4629 18.999H13.5723L14.1631 19.6006V26.0283H16.5283V19.9648L17.5078 18.999H19.0596L19.6885 19.6367V26.0283H22.127V18.9268L20.1504 16.96H16.9346L15.6787 18.2168L14.4219 16.96H12.0938L10.5967 18.4531V16.96H8.34277V26.0283ZM30.9395 17.8535L29.8516 16.9209H26.2021L24.3037 18.8223V24.127L26.2021 26.0283H29.668L31.0869 24.6201V26.0283H33.3721V12.9697H30.9395V17.8535ZM30.9395 20.085V22.4619L29.4463 23.9805H27.4375L26.7363 23.2666V19.6826L27.4375 18.9688H29.6855L30.9395 20.085Z" fill="#7F56D9"/>
<path d="M230.108 26.2823V23.6797H235.655V24.8744L236.594 25.8557H243.506L244.444 24.8744V23.0397L243.463 22.0157H234.29L230.279 17.9624V13.3118L234.332 9.21582H245.426L249.564 13.3971V15.9998H244.018V14.8051L243.079 13.8238H236.764L235.826 14.8051V16.4691L236.807 17.4931H245.98L249.991 21.5464V26.3677L245.938 30.4636H234.247L230.108 26.2823Z" fill="#1E1E1E"/>
<path d="M206.957 26.1117V13.5678L211.266 9.21582H222.957L227.352 13.6531V17.5784H221.72V15.4878L220.226 13.9944H214.082L212.589 15.4878V24.1917L214.082 25.685H220.226L221.72 24.1917V22.101H227.352V26.0263L222.957 30.4636H211.266L206.957 26.1117Z" fill="#1E1E1E"/>
<path d="M181.708 26.0263V13.6531L186.102 9.21582H198.305L202.699 13.6531V26.0263L198.305 30.4636H186.102L181.708 26.0263ZM195.574 25.7703L197.067 24.277V15.4024L195.574 13.9091H188.833L187.339 15.4024V24.277L188.833 25.7703H195.574Z" fill="#1E1E1E"/>
<path d="M156.041 26.0264V13.6532L160.435 9.21592H168.883L171.4 11.3919V0H177.032V30.4637H171.742V27.1784L168.456 30.4637H160.435L156.041 26.0264ZM167.944 25.6851L171.4 22.1438V16.5972L168.499 13.9945H163.294L161.672 15.6585V24.0211L163.294 25.6851H167.944Z" fill="#1E1E1E"/>
<path d="M131.217 9.21582H136.423V12.7571L139.964 9.21582H146.833L151.569 13.9518V30.4636H145.937V15.4878L144.486 13.9944H140.903L136.849 18.0904V30.4636H131.217V9.21582Z" fill="#1E1E1E"/>
<path d="M105.917 26.1117V13.6531L110.311 9.21582H122.3L126.738 13.6531V21.717H111.548V24.4477L112.914 25.8557H119.868L121.148 24.533V23.4237H126.695V26.197L122.471 30.4636H110.226L105.917 26.1117ZM121.106 17.7917V15.3171L119.655 13.8238H112.999L111.548 15.3171V17.7917H121.106Z" fill="#1E1E1E"/>
<path d="M80.6763 9.21582H85.8816V12.3305L88.9962 9.21582H97.2735L101.668 13.6531V26.0263L97.2735 30.4636H89.0389L86.3082 28.2023V39.5089H80.6763V9.21582ZM94.5428 25.685L96.0361 24.1917V15.4878L94.5428 13.9944H89.7215L86.3082 17.4504V22.6557L89.6789 25.685H94.5428Z" fill="#1E1E1E"/>
<path d="M55 26.0263V13.6531L59.3946 9.21582H71.5972L75.9918 13.6531V26.0263L71.5972 30.4636H59.3946L55 26.0263ZM68.8665 25.7703L70.3599 24.277V15.4024L68.8665 13.9091H62.1253L60.632 15.4024V24.277L62.1253 25.7703H68.8665Z" fill="#1E1E1E"/>
</svg>`;
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
