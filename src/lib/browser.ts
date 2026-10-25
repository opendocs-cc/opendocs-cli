import { spawn } from "node:child_process";

/**
 * Opens `url` in the default browser (`open` / `xdg-open` / `start`), without
 * waiting for it. Never rejects: when no browser can be started the caller
 * has already printed the URL for the user to open themselves.
 */
export function openBrowser(url: string): Promise<void> {
  const command =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "cmd"
        : "xdg-open";
  // `cmd /c start` treats `&` as a command separator, so escape it or a
  // URL with query parameters is cut at the first one.
  const args =
    process.platform === "win32"
      ? ["/c", "start", "", url.replace(/&/g, "^&")]
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
