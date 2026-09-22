import { Client, WSClient, EventDispatcher } from "@larksuiteoapi/node-sdk";
import type { FeishuConfig } from "./config.js";

export interface IncomingMessage {
  messageId: string;
  chatId: string;
  senderId: string;
  text: string;
}

export type MessageHandler = (msg: IncomingMessage) => void | Promise<void>;

/** Feishu text limit per message is ~150KB but keep chunks small for readability. */
const MAX_TEXT = 3500;

export class FeishuGateway {
  private client: Client;
  private wsClient: WSClient;
  private dispatcher: EventDispatcher;
  private messageHandler?: MessageHandler;
  private processed = new Set<string>();

  constructor(config: FeishuConfig) {
    this.client = new Client({ appId: config.app_id, appSecret: config.app_secret });
    this.wsClient = new WSClient({ appId: config.app_id, appSecret: config.app_secret });
    this.dispatcher = new EventDispatcher({});
    this.dispatcher.register({ "im.message.receive_v1": (data) => this.handleReceive(data) });
  }

  onMessage(handler: MessageHandler): void {
    this.messageHandler = handler;
  }

  async start(): Promise<void> {
    await this.wsClient.start({ eventDispatcher: this.dispatcher });
  }

  /** Send plain text to a chat, chunked if long. Uses the send API
   * (im.v1.message.create with chat_id), not the reply API. */
  async sendText(chatId: string, text: string): Promise<void> {
    const chunks = splitChunks(text, MAX_TEXT);
    for (let i = 0; i < chunks.length; i++) {
      const prefix = chunks.length > 1 ? `(${i + 1}/${chunks.length})\n` : "";
      await this.client.im.v1.message.create({
        data: {
          receive_id: chatId,
          msg_type: "text",
          content: JSON.stringify({ text: prefix + chunks[i] }),
        },
        params: { receive_id_type: "chat_id" },
      });
    }
  }

  private async handleReceive(data: any): Promise<void> {
    if (!this.messageHandler) return;
    const { message, sender } = data ?? {};
    if (!message || !sender) return;

    if (this.processed.has(message.message_id)) return;
    this.processed.add(message.message_id);
    if (this.processed.size > 1000) {
      for (const id of Array.from(this.processed).slice(0, 200)) this.processed.delete(id);
    }

    if (message.message_type !== "text") return;

    let text = "";
    try {
      text = JSON.parse(message.content).text ?? "";
    } catch {
      return;
    }

    for (const m of message.mentions ?? []) {
      text = text.split(m.key).join("");
    }
    text = text.trim();
    if (!text) return;

    await this.messageHandler({
      messageId: message.message_id,
      chatId: message.chat_id,
      senderId: sender.sender_id?.open_id ?? "",
      text,
    });
  }
}

function splitChunks(text: string, maxLen: number): string[] {
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > maxLen) {
    let cut = remaining.lastIndexOf("\n", maxLen);
    if (cut < maxLen * 0.5) cut = maxLen;
    chunks.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut).replace(/^\n+/, "");
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}
