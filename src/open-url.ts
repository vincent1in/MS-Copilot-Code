/**
 * Open the gateway's own page in the default browser.
 *
 * Only ever called with a link this process built (`http://127.0.0.1:<port>/#k=<key>`),
 * never with anything from a request or a model. It starts the operating system's
 * URL opener directly, with no shell in between, and does not wait for it.
 *
 * The link carries the page's key, and an argument to a child process is visible to
 * other local users' process listings for the moment it runs. On a shared machine,
 * pass `--no-open` and paste the printed link instead.
 */

import { spawn } from "node:child_process";

const LOCAL_PAGE = /^http:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):\d{1,5}\/(?:#k=[A-Za-z0-9_-]+)?$/;

/** Returns whether an opener was started. Never throws: the link is printed anyway. */
export function openInBrowser(link: string): boolean {
  if (!LOCAL_PAGE.test(link)) return false;
  const [command, args] =
    process.platform === "darwin"
      ? ["open", [link]]
      : process.platform === "win32"
        ? ["rundll32", ["url.dll,FileProtocolHandler", link]]
        : ["xdg-open", [link]];
  try {
    const child = spawn(command, args, { stdio: "ignore", detached: true, windowsHide: true });
    child.on("error", () => {
      /* no opener on this system; the printed link still works */
    });
    child.unref();
    return true;
  } catch {
    return false;
  }
}
