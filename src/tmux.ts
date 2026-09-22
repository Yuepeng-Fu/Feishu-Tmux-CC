import { execFile } from "node:child_process";

export interface TmuxSessionInfo {
  name: string;
  attached: boolean;
  windows: number;
}

function run(args: string[], opts?: { stdin?: string }): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = execFile("tmux", args, { maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(`tmux ${args.join(" ")}: ${stderr || err.message}`));
        return;
      }
      resolve(stdout);
    });
    if (opts?.stdin !== undefined) {
      proc.stdin!.end(opts.stdin);
    }
  });
}

/** List all tmux sessions. Returns [] when no server is running. */
export async function listSessions(): Promise<TmuxSessionInfo[]> {
  try {
    const out = await run(["list-sessions", "-F", "#{session_name}|#{session_attached}|#{session_windows}"]);
    return out.trim().split("\n").filter(Boolean).map((line) => {
      const [name, attached, windows] = line.split("|");
      return { name, attached: attached === "1", windows: Number(windows) };
    });
  } catch {
    return [];
  }
}

export async function hasSession(name: string): Promise<boolean> {
  try {
    await run(["has-session", "-t", name]);
    return true;
  } catch {
    return false;
  }
}

/** Inject text into the session's active pane. Single line: send-keys + Enter.
 * Multi-line: paste-buffer (bracketed paste, Claude TUI treats it as one block) + Enter. */
export async function sendText(session: string, text: string): Promise<void> {
  if (!text.includes("\n")) {
    await run(["send-keys", "-t", session, "-l", "--", text]);
    await run(["send-keys", "-t", session, "Enter"]);
    return;
  }
  await run(["load-buffer", "-"], { stdin: text });
  await run(["paste-buffer", "-t", session]);
  await run(["send-keys", "-t", session, "Enter"]);
}

/** Send a special key, e.g. "Escape" or "C-c". */
export async function sendKey(session: string, key: string): Promise<void> {
  await run(["send-keys", "-t", session, key]);
}

/** Capture pane content as plain text (ANSI stripped by tmux).
 * lines: number of lines from history to include (negative start). */
export async function capture(session: string, lines: number): Promise<string> {
  return run(["capture-pane", "-p", "-t", session, "-S", `-${lines}`]);
}

/** Capture only the currently visible screen (no scrollback history).
 * The Claude TUI's busy footer lives on the visible screen; old busy text
 * scrolled into history must not trigger busy detection. */
export async function captureScreen(session: string): Promise<string> {
  return run(["capture-pane", "-p", "-t", session, "-S", "0", "-E", "-"]);
}
