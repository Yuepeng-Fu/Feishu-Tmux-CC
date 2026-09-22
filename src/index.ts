import { loadConfig } from "./config.js";
import { FeishuGateway } from "./feishu.js";
import { CommandRouter } from "./commands.js";
import { BindingStore } from "./store.js";

async function main(): Promise<void> {
  const configPath = process.argv[2];
  const cfg = loadConfig(configPath);
  const gateway = new FeishuGateway(cfg.feishu);
  const store = new BindingStore();
  const router = new CommandRouter(gateway, store, cfg);

  gateway.onMessage(async (msg) => {
    try {
      const allow = cfg.security.allowed_chat_ids ?? [];
      if (allow.length > 0 && !allow.includes(msg.chatId)) {
        console.log(`[security] ignored message from unlisted chat ${msg.chatId}`);
        return;
      }
      await router.handle(msg);
    } catch (err) {
      console.error("[handler]", err);
      try {
        await gateway.sendText(msg.chatId, `❌ 处理失败: ${err instanceof Error ? err.message : String(err)}`);
      } catch {
        // sending the error itself failed; nothing more to do
      }
    }
  });

  await router.restoreBindings();
  console.log("[feishu-tmux-cc] starting websocket connection");
  await gateway.start();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
