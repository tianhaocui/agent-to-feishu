import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface Config {
  runtime: 'claude' | 'codex' | 'auto';
  enabledChannels: string[];
  defaultWorkDir: string;
  defaultModel?: string;
  defaultMode: string;
  // Feishu
  feishuAppId?: string;
  feishuAppSecret?: string;
  feishuDomain?: string;
  feishuAllowedUsers?: string[];
  feishuPairingEnabled?: boolean;
  feishuPairingAdminUsers?: string[];
  feishuPairingAutoApproveUsers?: string[];
  feishuPairingRequireDirectMessage?: boolean;
  // Auto-approve all tool permission requests without user confirmation
  autoApprove?: boolean;
}

export const CTI_HOME = process.env.CTI_HOME || path.join(os.homedir(), ".claude-to-im");
export const CONFIG_PATH = path.join(CTI_HOME, "config.env");

function parseEnvFile(content: string): Map<string, string> {
  const entries = new Map<string, string>();
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let value = trimmed.slice(eqIdx + 1).trim();
    // Strip surrounding quotes
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    entries.set(key, value);
  }
  return entries;
}

function splitCsv(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  return value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function loadConfig(): Config {
  let env = new Map<string, string>();
  try {
    const content = fs.readFileSync(CONFIG_PATH, "utf-8");
    env = parseEnvFile(content);
  } catch {
    // Config file doesn't exist yet — use defaults
  }

  const rawRuntime = env.get("CTI_RUNTIME") || "claude";
  const runtime = (["claude", "codex", "auto"].includes(rawRuntime) ? rawRuntime : "claude") as Config["runtime"];

  return {
    runtime,
    enabledChannels: splitCsv(env.get("CTI_ENABLED_CHANNELS")) ?? [],
    defaultWorkDir: env.get("CTI_DEFAULT_WORKDIR") || process.cwd(),
    defaultModel: env.get("CTI_DEFAULT_MODEL") || undefined,
    defaultMode: env.get("CTI_DEFAULT_MODE") || "code",
    feishuAppId: env.get("CTI_FEISHU_APP_ID") || undefined,
    feishuAppSecret: env.get("CTI_FEISHU_APP_SECRET") || undefined,
    feishuDomain: env.get("CTI_FEISHU_DOMAIN") || undefined,
    feishuAllowedUsers: splitCsv(env.get("CTI_FEISHU_ALLOWED_USERS")),
    feishuPairingEnabled: env.get("CTI_FEISHU_PAIRING_ENABLED") === "true",
    feishuPairingAdminUsers: splitCsv(env.get("CTI_FEISHU_PAIRING_ADMIN_USERS")),
    feishuPairingAutoApproveUsers: splitCsv(env.get("CTI_FEISHU_PAIRING_AUTO_APPROVE_USERS")),
    feishuPairingRequireDirectMessage: env.has("CTI_FEISHU_PAIRING_REQUIRE_DIRECT_MESSAGE")
      ? env.get("CTI_FEISHU_PAIRING_REQUIRE_DIRECT_MESSAGE") === "true"
      : undefined,
    autoApprove: env.get("CTI_AUTO_APPROVE") === "true",
  };
}

function formatEnvLine(key: string, value: string | undefined): string {
  if (value === undefined || value === "") return "";
  return `${key}=${value}\n`;
}

export function saveConfig(config: Config): void {
  let out = "";
  out += formatEnvLine("CTI_RUNTIME", config.runtime);
  out += formatEnvLine(
    "CTI_ENABLED_CHANNELS",
    config.enabledChannels.join(",")
  );
  out += formatEnvLine("CTI_DEFAULT_WORKDIR", config.defaultWorkDir);
  if (config.defaultModel) out += formatEnvLine("CTI_DEFAULT_MODEL", config.defaultModel);
  out += formatEnvLine("CTI_DEFAULT_MODE", config.defaultMode);
  out += formatEnvLine("CTI_FEISHU_APP_ID", config.feishuAppId);
  out += formatEnvLine("CTI_FEISHU_APP_SECRET", config.feishuAppSecret);
  out += formatEnvLine("CTI_FEISHU_DOMAIN", config.feishuDomain);
  out += formatEnvLine(
    "CTI_FEISHU_ALLOWED_USERS",
    config.feishuAllowedUsers?.join(",")
  );
  if (config.feishuPairingEnabled !== undefined)
    out += formatEnvLine("CTI_FEISHU_PAIRING_ENABLED", String(config.feishuPairingEnabled));
  out += formatEnvLine(
    "CTI_FEISHU_PAIRING_ADMIN_USERS",
    config.feishuPairingAdminUsers?.join(",")
  );
  out += formatEnvLine(
    "CTI_FEISHU_PAIRING_AUTO_APPROVE_USERS",
    config.feishuPairingAutoApproveUsers?.join(",")
  );
  if (config.feishuPairingRequireDirectMessage !== undefined)
    out += formatEnvLine(
      "CTI_FEISHU_PAIRING_REQUIRE_DIRECT_MESSAGE",
      String(config.feishuPairingRequireDirectMessage)
    );

  fs.mkdirSync(CTI_HOME, { recursive: true });
  const tmpPath = CONFIG_PATH + ".tmp";
  fs.writeFileSync(tmpPath, out, { mode: 0o600 });
  fs.renameSync(tmpPath, CONFIG_PATH);
}

export function maskSecret(value: string): string {
  if (value.length <= 4) return "****";
  return "*".repeat(value.length - 4) + value.slice(-4);
}

export function configToSettings(config: Config): Map<string, string> {
  const m = new Map<string, string>();
  m.set("remote_bridge_enabled", "true");

  // ── Feishu ──
  m.set(
    "bridge_feishu_enabled",
    config.enabledChannels.includes("feishu") ? "true" : "false"
  );
  if (config.feishuAppId) m.set("bridge_feishu_app_id", config.feishuAppId);
  if (config.feishuAppSecret)
    m.set("bridge_feishu_app_secret", config.feishuAppSecret);
  if (config.feishuDomain) m.set("bridge_feishu_domain", config.feishuDomain);
  if (config.feishuAllowedUsers)
    m.set("bridge_feishu_allowed_users", config.feishuAllowedUsers.join(","));
  if (config.feishuPairingEnabled !== undefined)
    m.set("bridge_feishu_pairing_enabled", String(config.feishuPairingEnabled));
  if (config.feishuPairingAdminUsers)
    m.set("bridge_feishu_pairing_admin_users", config.feishuPairingAdminUsers.join(","));
  if (config.feishuPairingAutoApproveUsers)
    m.set(
      "bridge_feishu_pairing_auto_approve_users",
      config.feishuPairingAutoApproveUsers.join(",")
    );
  if (config.feishuPairingRequireDirectMessage !== undefined)
    m.set(
      "bridge_feishu_pairing_require_direct_message",
      String(config.feishuPairingRequireDirectMessage)
    );

  // ── Defaults ──
  m.set("bridge_default_work_dir", config.defaultWorkDir);
  if (config.defaultModel) {
    m.set("bridge_default_model", config.defaultModel);
    m.set("default_model", config.defaultModel);
  }
  m.set("bridge_default_mode", config.defaultMode);

  return m;
}
