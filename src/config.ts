import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import TOML from "@iarna/toml";

export interface FeishuConfig {
  app_id: string;
  app_secret: string;
}

export interface BotConfig {
  poll_ms?: number;
  snap_lines?: number;
  idle_stable_count?: number;
}

export interface SecurityConfig {
  allowed_chat_ids?: string[];
}

export interface AppConfig {
  feishu: FeishuConfig;
  bot: BotConfig;
  security: SecurityConfig;
}

export function loadConfig(configPath?: string): AppConfig {
  const filePath = configPath ?? resolve(process.cwd(), "config.toml");
  const parsed = TOML.parse(readFileSync(filePath, "utf-8")) as unknown as AppConfig;

  if (!parsed.feishu?.app_id || !parsed.feishu?.app_secret) {
    throw new Error(`Missing feishu.app_id or feishu.app_secret in ${filePath}`);
  }

  return {
    feishu: parsed.feishu,
    bot: parsed.bot ?? {},
    security: parsed.security ?? {},
  };
}

export function pollIntervalMs(cfg: AppConfig): number {
  return cfg.bot.poll_ms && cfg.bot.poll_ms >= 500 ? cfg.bot.poll_ms : 1500;
}

export function snapLines(cfg: AppConfig): number {
  return cfg.bot.snap_lines && cfg.bot.snap_lines > 0 ? cfg.bot.snap_lines : 300;
}

export function idleStableCount(cfg: AppConfig): number {
  return cfg.bot.idle_stable_count && cfg.bot.idle_stable_count > 0 ? cfg.bot.idle_stable_count : 3;
}
