# feishu-tmux-cc

飞书 ↔ tmux-Claude Code 远程介入桥。接入远程服务器上**已经在跑**的 tmux-Claude Code 会话：从飞书注入消息、打断、看屏幕快照、感知空闲。

## 特性

- `/attach` 动态绑定飞书聊天 ↔ 既有 tmux 会话（持久化，bot 重启自动恢复）
- 免命令文本直接注入（多行自动走 bracketed paste，不逐行误提交）
- 空闲检测：Claude 忙时 footer 出现 "(esc to interrupt)"，完成后通知 + 尾部预览
- 会话消失通知，同名会话重现自动恢复观测

## 命令

| 命令 | 说明 |
|---|---|
| `/ls` | 列出服务器所有 tmux 会话 |
| `/attach <name>` | 绑定当前聊天到 tmux 会话 |
| `/detach` | 解绑 |
| `/snap [lines]` | 屏幕快照（默认近 300 行） |
| `/tail [N]` | 最近 N 行（默认 30） |
| `/key <k...>` | 发送特殊键序列，如 `/key Down Down Enter` 选第三项 |
| `/up` `/down` `/left` `/right` `/enter` `/space` `/tab` | 单键快捷方式 |
| `/esc` | 发 Esc 打断 Claude |
| `/ctrl-c` | 发 Ctrl+C |
| `/status` | 绑定与空闲状态 |
| `/help` | 帮助 |

## 部署

```bash
cp config.example.toml config.toml  # 填入 app_id / app_secret
npm install
npm run dev        # 开发运行 (tsx)
npm run build && npm start   # 生产运行
```

需要飞书应用开启**事件订阅（WebSocket 长连接模式）**并订阅 `im.message.receive_v1`，机器人进群/私聊可用。

## 安全

`[security] allowed_chat_ids` 可配置聊天白名单；为空则不限制。注意：注入的是真实键击，目标会话若以高权限运行 Claude（如 skip-permissions），等同于把控制权交给了飞书侧——建议配置白名单。

## 已知边界

- 空闲判定基于 footer 正则 + 内容稳定性启发式，Claude TUI 大改版可能需要调整 `watcher.ts` 中的 `BUSY_RE`
- 纯文本回传，不做流式卡片（后续可迭代）
- 一个聊天同一时间绑定一个 tmux 会话
