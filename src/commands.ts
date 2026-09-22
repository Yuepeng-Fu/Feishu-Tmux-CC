import type { FeishuGateway, IncomingMessage } from "./feishu.js";
import { BindingStore } from "./store.js";
import { SessionWatcher } from "./watcher.js";
import { capture, hasSession, listSessions, sendKey, sendText } from "./tmux.js";
import { idleStableCount, pollIntervalMs, snapLines, type AppConfig } from "./config.js";

const HELP = [
  "/ls - 列出所有 tmux 会话",
  "/attach <name> - 绑定当前聊天到一个 tmux 会话",
  "/detach - 解除绑定",
  "/snap [lines] - 屏幕快照（默认近 300 行）",
  "/tail [N] - 最近 N 行（默认 30）",
  "/key <k...> - 发送特殊键，可多个，如 /key Down Down Enter",
  "/up /down /left /right /enter /space /tab - 单键快捷方式",
  "/esc - 发送 Esc 打断 Claude",
  "/ctrl-c - 发送 Ctrl+C",
  "/status - 绑定与空闲状态",
  "/help - 本帮助",
  "其他文本将直接注入绑定的 tmux 会话（多行按一次粘贴提交）",
].join("\n");

/** tmux key names we allow sending (validated against footguns). */
const ALLOWED_KEYS = new Set([
  "Up", "Down", "Left", "Right", "Enter", "Space", "Tab", "BSpace",
  "Escape", "Home", "End", "PgUp", "PgDn",
  "C-a", "C-c", "C-d", "C-e", "C-l", "C-u", "C-w",
  "F1", "F2", "F3", "F4", "F5", "F6", "F7", "F8", "F9", "F10", "F11", "F12",
]);

const KEY_ALIASES: Record<string, string> = {
  up: "Up", down: "Down", left: "Left", right: "Right",
  enter: "Enter", space: "Space", tab: "Tab", bspace: "BSpace",
};

const STATE_LABEL: Record<string, string> = {
  starting: "观测中(初始化)",
  idle: "空闲",
  busy: "工作中",
  lost: "失联",
  stopped: "已停止",
};

export class CommandRouter {
  private gateway: FeishuGateway;
  private store: BindingStore;
  private cfg: AppConfig;
  private watchers = new Map<string, SessionWatcher>();

  constructor(gateway: FeishuGateway, store: BindingStore, cfg: AppConfig) {
    this.gateway = gateway;
    this.store = store;
    this.cfg = cfg;
  }

  /** Restore persisted bindings on startup. */
  async restoreBindings(): Promise<void> {
    for (const [chatId, binding] of this.store.entries()) {
      const alive = await hasSession(binding.session);
      this.startWatcher(chatId, binding.session);
      if (alive) {
        await this.gateway.sendText(chatId, `🔄 已恢复绑定: ${binding.session}`);
      }
      // if not alive, the watcher will fire onLost after its first polls
    }
  }

  async handle(msg: IncomingMessage): Promise<void> {
    const text = msg.text.trim();

    if (text.startsWith("/")) {
      await this.handleCommand(msg.chatId, text);
    } else {
      await this.inject(msg.chatId, text);
    }
  }

  private async handleCommand(chatId: string, text: string): Promise<void> {
    const [cmd, ...args] = text.slice(1).split(/\s+/);
    switch (cmd) {
      case "help":
        await this.gateway.sendText(chatId, HELP);
        return;
      case "ls":
        await this.cmdLs(chatId);
        return;
      case "attach":
        await this.cmdAttach(chatId, args[0]);
        return;
      case "detach":
        await this.cmdDetach(chatId);
        return;
      case "snap":
        await this.cmdSnap(chatId, args[0]);
        return;
      case "tail":
        await this.cmdTail(chatId, args[0]);
        return;
      case "key":
        await this.cmdKey(chatId, args);
        return;
      case "up":
      case "down":
      case "left":
      case "right":
      case "enter":
      case "space":
      case "tab":
      case "bspace":
        await this.cmdKey(chatId, [KEY_ALIASES[cmd]]);
        return;
      case "esc":
        await this.withBinding(chatId, async (s) => {
          await sendKey(s, "Escape");
          await this.gateway.sendText(chatId, "⎋ 已发送 Esc");
        });
        return;
      case "ctrl-c":
        await this.withBinding(chatId, async (s) => {
          await sendKey(s, "C-c");
          await this.gateway.sendText(chatId, "⏹ 已发送 Ctrl+C");
        });
        return;
      case "status":
        await this.cmdStatus(chatId);
        return;
      default:
        await this.gateway.sendText(chatId, `未知命令 /${cmd}\n\n${HELP}`);
    }
  }

  private async cmdLs(chatId: string): Promise<void> {
    const sessions = await listSessions();
    if (sessions.length === 0) {
      await this.gateway.sendText(chatId, "没有正在运行的 tmux 会话");
      return;
    }
    const bound = this.store.get(chatId)?.session;
    const lines = sessions.map((s) => {
      const mark = s.name === bound ? " ← 当前绑定" : "";
      return `${s.name} (${s.windows} 窗口, ${s.attached ? "已attach" : "无人attach"})${mark}`;
    });
    await this.gateway.sendText(chatId, `tmux 会话:\n${lines.join("\n")}`);
  }

  private async cmdAttach(chatId: string, name?: string): Promise<void> {
    if (!name) {
      await this.gateway.sendText(chatId, "用法: /attach <session-name>，先用 /ls 查看");
      return;
    }
    if (!(await hasSession(name))) {
      await this.gateway.sendText(chatId, `❌ tmux 会话 "${name}" 不存在，用 /ls 查看列表`);
      return;
    }
    this.stopWatcher(chatId);
    this.store.set(chatId, name);
    this.startWatcher(chatId, name);
    await this.gateway.sendText(chatId, `✅ 已绑定 ${name}，空闲状态变化会在此通知。直接发文本即可注入。`);
  }

  private async cmdKey(chatId: string, keys: string[]): Promise<void> {
    if (keys.length === 0) {
      await this.gateway.sendText(chatId, `用法: /key <k...>，如 /key Down Down Enter\n可用键: ${Array.from(ALLOWED_KEYS).join(" ")}`);
      return;
    }
    const bad = keys.filter((k) => !ALLOWED_KEYS.has(k));
    if (bad.length > 0) {
      await this.gateway.sendText(chatId, `不支持的键: ${bad.join(" ")}\n可用键: ${Array.from(ALLOWED_KEYS).join(" ")}`);
      return;
    }
    await this.withBinding(chatId, async (s) => {
      for (const k of keys) await sendKey(s, k);
      await this.gateway.sendText(chatId, `⌨ 已发送: ${keys.join(" ")}`);
    });
  }

  private async cmdDetach(chatId: string): Promise<void> {
    const binding = this.store.get(chatId);
    if (!binding) {
      await this.gateway.sendText(chatId, "当前没有绑定，用 /attach <name> 绑定");
      return;
    }
    this.stopWatcher(chatId);
    this.store.remove(chatId);
    await this.gateway.sendText(chatId, `已解除绑定 ${binding.session}`);
  }

  private async cmdSnap(chatId: string, arg?: string): Promise<void> {
    const lines = Math.min(Number(arg) || snapLines(this.cfg), 2000);
    await this.withBinding(chatId, async (s) => {
      const out = normalize(await capture(s, lines));
      await this.gateway.sendText(chatId, `🖥 ${s} (近 ${lines} 行):\n${out}`);
    });
  }

  private async cmdTail(chatId: string, arg?: string): Promise<void> {
    const lines = Math.min(Math.max(Number(arg) || 30, 1), 200);
    await this.withBinding(chatId, async (s) => {
      const out = normalize(await capture(s, Math.max(lines, 40)));
      await this.gateway.sendText(chatId, `🖥 ${s} (最近 ${lines} 行):\n${lastN(out, lines)}`);
    });
  }

  private async cmdStatus(chatId: string): Promise<void> {
    const binding = this.store.get(chatId);
    if (!binding) {
      await this.gateway.sendText(chatId, "未绑定。/ls 查看，/attach <name> 绑定");
      return;
    }
    const alive = await hasSession(binding.session);
    const state = this.watchers.get(chatId)?.getState() ?? "stopped";
    await this.gateway.sendText(
      chatId,
      `绑定: ${binding.session}\ntmux 会话: ${alive ? "存活" : "不存在"}\n状态: ${STATE_LABEL[state] ?? state}\n绑定时间: ${binding.boundAt}`,
    );
  }

  private async inject(chatId: string, text: string): Promise<void> {
    await this.withBinding(chatId, async (s) => {
      await sendText(s, text);
      const desc = text.includes("\n") ? `多行粘贴, ${text.split("\n").length} 行` : `${text.length} 字`;
      await this.gateway.sendText(chatId, `📨 已注入 ${s} (${desc})`);
    });
  }

  private async withBinding(chatId: string, fn: (session: string) => Promise<void>): Promise<void> {
    const binding = this.store.get(chatId);
    if (!binding) {
      await this.gateway.sendText(chatId, "未绑定 tmux 会话。/ls 查看，/attach <name> 绑定，/help 全部命令");
      return;
    }
    await fn(binding.session);
  }

  private startWatcher(chatId: string, session: string): void {
    const watcher = new SessionWatcher(session, {
      pollMs: pollIntervalMs(this.cfg),
      idleStableCount: idleStableCount(this.cfg),
      onIdle: (s, tail) => {
        void this.gateway.sendText(chatId, `✅ ${s} 已空闲\n${lastN(normalize(tail), 10)}`);
      },
      onLost: (s) => {
        void this.gateway.sendText(chatId, `⚠️ tmux 会话 ${s} 已消失。同名会话重新出现后将自动恢复观测。`);
      },
      onRestore: (s) => {
        void this.gateway.sendText(chatId, `🔄 会话 ${s} 重新出现，已恢复观测`);
      },
    });
    watcher.start();
    this.watchers.set(chatId, watcher);
  }

  private stopWatcher(chatId: string): void {
    this.watchers.get(chatId)?.stop();
    this.watchers.delete(chatId);
  }
}

/** Trim trailing blank lines and collapse 3+ consecutive blanks. */
function normalize(text: string): string {
  let out = text.split("\n").map((l) => l.trimEnd());
  while (out.length && out[out.length - 1] === "") out.pop();
  return out.join("\n").replace(/\n{3,}/g, "\n\n");
}

function lastN(text: string, n: number): string {
  const lines = text.split("\n");
  return lines.length <= n ? text : lines.slice(-n).join("\n");
}
