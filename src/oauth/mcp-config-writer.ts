/**
 * Update MCP config to inject/remove user_access_token for lark-mcp.
 * Claude Code reads MCP config from ~/.claude.json (global mcpServers),
 * NOT from ~/.claude/settings.json.
 */

import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

const CONFIG_PATH = join(process.env.HOME || '/root', '.claude.json');

function findLarkMcp(settings: any): { args: string[]; source: string } | null {
  // Check global mcpServers
  const global = settings.mcpServers?.['lark-mcp'];
  if (global?.args) return { args: global.args, source: 'global' };
  if (global?.command && !global.args) {
    // command-only format: split command string into args
    return null;
  }
  // Check project-level mcpServers
  for (const [, proj] of Object.entries(settings.projects || {})) {
    const p = proj as any;
    const lark = p?.mcpServers?.['lark-mcp'];
    if (lark?.args) return { args: lark.args, source: 'project' };
  }
  return null;
}

export function updateMcpUserToken(token: string): void {
  try {
    const raw = readFileSync(CONFIG_PATH, 'utf8');
    const settings = JSON.parse(raw);
    const lark = findLarkMcp(settings);
    if (!lark) {
      console.warn('[mcp-config] No lark-mcp config found in .claude.json');
      return;
    }

    const args = lark.args;

    // Remove --oauth if present
    const oauthIdx = args.indexOf('--oauth');
    if (oauthIdx >= 0) args.splice(oauthIdx, 1);

    // Remove existing --user-access-token + value
    const uatIdx = args.indexOf('--user-access-token');
    if (uatIdx >= 0) args.splice(uatIdx, 2);

    // Add --user-access-token
    args.push('--user-access-token', token);

    writeFileSync(CONFIG_PATH, JSON.stringify(settings, null, 2) + '\n');
    console.log('[mcp-config] Updated lark-mcp with user_access_token');
  } catch (err) {
    console.warn('[mcp-config] Failed to update .claude.json:', err instanceof Error ? err.message : err);
  }
}

export function clearMcpUserToken(): void {
  try {
    const raw = readFileSync(CONFIG_PATH, 'utf8');
    const settings = JSON.parse(raw);
    const lark = findLarkMcp(settings);
    if (!lark) return;

    const args = lark.args;

    // Remove --user-access-token + value
    const uatIdx = args.indexOf('--user-access-token');
    if (uatIdx >= 0) args.splice(uatIdx, 2);

    // Add --oauth back if not present
    if (!args.includes('--oauth')) args.push('--oauth');

    writeFileSync(CONFIG_PATH, JSON.stringify(settings, null, 2) + '\n');
    console.log('[mcp-config] Cleared user_access_token, restored --oauth');
  } catch (err) {
    console.warn('[mcp-config] Failed to update .claude.json:', err instanceof Error ? err.message : err);
  }
}
