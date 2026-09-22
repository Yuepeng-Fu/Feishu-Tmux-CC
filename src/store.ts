import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface Binding {
  session: string;
  boundAt: string;
}

/** Persistent chat_id → tmux session bindings, stored as JSON with atomic writes. */
export class BindingStore {
  private file: string;
  private bindings = new Map<string, Binding>();

  constructor(dir = join(homedir(), ".feishu-tmux-cc")) {
    mkdirSync(dir, { recursive: true });
    this.file = join(dir, "bindings.json");
    this.load();
  }

  private load(): void {
    try {
      const raw = JSON.parse(readFileSync(this.file, "utf-8")) as Record<string, Binding>;
      for (const [chatId, b] of Object.entries(raw)) {
        if (b?.session) this.bindings.set(chatId, { session: b.session, boundAt: b.boundAt ?? "" });
      }
    } catch {
      // no file or corrupt: start empty
    }
  }

  private save(): void {
    const obj = Object.fromEntries(this.bindings);
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(obj, null, 2));
    renameSync(tmp, this.file);
  }

  get(chatId: string): Binding | undefined {
    return this.bindings.get(chatId);
  }

  set(chatId: string, session: string): void {
    this.bindings.set(chatId, { session, boundAt: new Date().toISOString() });
    this.save();
  }

  remove(chatId: string): void {
    this.bindings.delete(chatId);
    this.save();
  }

  entries(): Array<[string, Binding]> {
    return Array.from(this.bindings.entries());
  }
}
