import { createHash } from "node:crypto";
import { capture, captureScreen, hasSession } from "./tmux.js";

export type WatchState = "starting" | "idle" | "busy" | "lost" | "stopped";

export interface WatcherOptions {
  pollMs: number;
  idleStableCount: number;
  /** Called once on each busy→idle transition. Receives a short tail preview. */
  onIdle: (session: string, tailPreview: string) => void;
  /** Called once when the tmux session disappears. */
  onLost: (session: string) => void;
  /** Called when a lost session reappears with the same name. */
  onRestore?: (session: string) => void;
}

const BUSY_RE = /to interrupt/i;
const POLL_LINES = 40;
const TAIL_LINES = 10;
const LOST_RECHECK_MS = 5000;
const LOST_AFTER_MISSES = 2;

/** Polls a bound tmux session and detects busy/idle transitions of the
 * Claude Code TUI. Busy = footer shows "... (esc to interrupt)" or content
 * still changing; idle = no busy marker and content hash stable for
 * idleStableCount consecutive polls. */
export class SessionWatcher {
  readonly session: string;
  private opts: WatcherOptions;
  private state: WatchState = "starting";
  private timer?: NodeJS.Timeout;
  private lostTimer?: NodeJS.Timeout;
  private lastHash = "";
  private stable = 0;
  private misses = 0;
  private polling = false;
  private armed = false;

  constructor(session: string, opts: WatcherOptions) {
    this.session = session;
    this.opts = opts;
  }

  getState(): WatchState {
    return this.state;
  }

  /** Run one poll cycle immediately (e.g. right after injecting keystrokes)
   * so callers can read a fresh state. Safe to call anytime. */
  async refresh(): Promise<void> {
    await this.poll();
  }

  /** Arm a one-shot idle report: the next time the session settles into idle
   * (whether or not a busy period was detected in between), fire onIdle.
   * Used after every user poke (text inject / keystrokes) so quick tool
   * calls without a visible busy footer still get a completion report.
   *
   * Stability must be re-established from scratch: the pre-poke screen was
   * already stable, so without resetting, the next poll would fire with
   * pre-poke content before the TUI even reacts to the keystrokes. */
  arm(): void {
    this.armed = true;
    this.stable = 0;
    this.lastHash = "";
  }

  start(): void {
    if (this.timer) return;
    // keep current state: "lost" is preserved so the first successful poll
    // after reconnect can fire onRestore
    this.timer = setInterval(() => void this.poll(), this.opts.pollMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.lostTimer) clearInterval(this.lostTimer);
    this.timer = this.lostTimer = undefined;
    this.state = "stopped";
  }

  private async poll(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      if (!(await hasSession(this.session))) {
        this.handleMiss();
        return;
      }
      if (this.state === "lost") {
        this.state = "idle";
        this.lastHash = "";
        this.stable = 0;
        this.opts.onRestore?.(this.session);
      }
      this.misses = 0;

      const [raw, screen] = await Promise.all([
        capture(this.session, POLL_LINES),
        captureScreen(this.session),
      ]);
      const lines = raw.split("\n").map((l) => l.trimEnd());
      while (lines.length && lines[lines.length - 1] === "") lines.pop();
      const screenLines = screen.split("\n").map((l) => l.trimEnd());
      while (screenLines.length && screenLines[screenLines.length - 1] === "") screenLines.pop();
      const bottom = screenLines.slice(-2).join("\n");
      const hash = createHash("md5").update(lines.join("\n")).digest("hex");

      if (BUSY_RE.test(bottom)) {
        this.stable = 0;
        this.state = "busy";
        return;
      }

      if (hash === this.lastHash) {
        this.stable++;
        const settled = this.stable >= this.opts.idleStableCount;
        const wasBusy = this.state === "busy";
        if (settled && (wasBusy || this.armed)) {
          this.state = "idle";
          this.armed = false;
          const tail = lines.slice(-TAIL_LINES).join("\n");
          this.opts.onIdle(this.session, tail);
        }
      } else {
        this.stable = 0;
        if (this.state === "starting") {
          // resolve silently: attaching to an already-idle session must not
          // fire a spurious idle notification
          this.state = BUSY_RE.test(bottom) ? "busy" : "idle";
        }
      }
      this.lastHash = hash;
    } catch {
      // transient tmux error: treat like a miss
      this.handleMiss();
    } finally {
      this.polling = false;
    }
  }

  private handleMiss(): void {
    this.misses++;
    if (this.state === "lost" || this.state === "stopped") return;
    if (this.misses < LOST_AFTER_MISSES) return;

    this.state = "lost";
    this.opts.onLost(this.session);
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    // slow recheck loop: resume polling if a session with the same name reappears
    this.lostTimer = setInterval(async () => {
      if (await hasSession(this.session)) {
        if (this.lostTimer) clearInterval(this.lostTimer);
        this.lostTimer = undefined;
        this.misses = 0;
        this.start();
      }
    }, LOST_RECHECK_MS);
  }
}
