/**
 * OAuthManager — orchestrates device flow, token storage, refresh, and MCP config.
 *
 * Lifecycle:
 *   1. ensureAuth() at startup — check stored token, refresh or trigger device flow
 *   2. startRefreshTimer() — background timer to proactively refresh tokens
 *   3. startDeviceFlow(chatId) — send auth card, poll for token, update MCP config
 */

import { requestDeviceAuthorization, pollDeviceToken } from './device-flow.js';
import { setStoredToken, findAnyToken, tokenStatus, type StoredUAToken } from './token-store.js';
import { refreshToken } from './token-refresh.js';
import { buildAuthCard, buildAuthSuccessCard, buildAuthFailedCard } from './oauth-cards.js';
import { updateMcpUserToken } from './mcp-config-writer.js';

export interface OAuthManagerConfig {
  appId: string;
  appSecret: string;
  domain: string;
  ctiHome: string;
  adminChatId: string;
  scope?: string;
}

export class OAuthManager {
  private config: OAuthManagerConfig;
  private sendCard: (chatId: string, cardJson: string) => Promise<void>;
  private patchCard: (messageId: string, cardJson: string) => Promise<void>;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private flowAbort: AbortController | null = null;

  constructor(
    config: OAuthManagerConfig,
    sendCard: (chatId: string, cardJson: string) => Promise<void>,
    patchCard: (messageId: string, cardJson: string) => Promise<void>,
  ) {
    this.config = config;
    this.sendCard = sendCard;
    this.patchCard = patchCard;
  }

  async ensureAuth(): Promise<boolean> {
    const { appId, ctiHome, domain, appSecret } = this.config;
    const token = findAnyToken(ctiHome, appId);

    if (token) {
      const status = tokenStatus(token);
      if (status === 'valid') {
        console.log('[oauth-manager] Existing token is valid');
        updateMcpUserToken(token.accessToken, appId, appSecret);
        return true;
      }
      if (status === 'needs_refresh') {
        console.log('[oauth-manager] Token needs refresh');
        const refreshed = await refreshToken({ appId, appSecret, domain, refreshToken: token.refreshToken });
        if (refreshed) {
          const now = Date.now();
          const updated: StoredUAToken = {
            ...token,
            accessToken: refreshed.accessToken,
            refreshToken: refreshed.refreshToken,
            expiresAt: now + refreshed.expiresIn * 1000,
            refreshExpiresAt: now + refreshed.refreshExpiresIn * 1000,
            scope: refreshed.scope || token.scope,
          };
          setStoredToken(ctiHome, updated);
          updateMcpUserToken(updated.accessToken, appId, appSecret);
          return true;
        }
      }
      console.log('[oauth-manager] Token expired, need re-auth');
    }

    // No valid token — trigger device flow (fire-and-forget, daemon continues starting)
    this.startDeviceFlow(this.config.adminChatId).catch(err => {
      console.warn('[oauth-manager] Device flow failed:', err instanceof Error ? err.message : err);
    });
    return false;
  }

  async startDeviceFlow(chatId: string): Promise<boolean> {
    const { appId, appSecret, domain, ctiHome, scope } = this.config;

    // Abort any existing flow
    if (this.flowAbort) { this.flowAbort.abort(); this.flowAbort = null; }
    this.flowAbort = new AbortController();

    try {
      // Step 1: Request device code
      const auth = await requestDeviceAuthorization({ appId, appSecret, domain, scope });

      // Step 2: Send auth card
      const cardJson = buildAuthCard({
        verificationUriComplete: auth.verificationUriComplete,
        userCode: auth.userCode,
        expiresIn: auth.expiresIn,
        domain,
      });
      await this.sendCard(chatId, cardJson);

      // Step 3: Poll for token
      console.log(`[oauth-manager] Polling for authorization (expires in ${auth.expiresIn}s)...`);
      const result = await pollDeviceToken({
        appId, appSecret, domain,
        deviceCode: auth.deviceCode,
        interval: auth.interval,
        expiresIn: auth.expiresIn,
        signal: this.flowAbort.signal,
      });

      if (!result.ok) {
        console.warn(`[oauth-manager] Device flow failed: ${result.message}`);
        await this.sendCard(chatId, buildAuthFailedCard(result.message));
        return false;
      }

      // Step 4: Verify user identity
      const userInfo = await this.getUserInfo(domain, result.token.accessToken);
      const userOpenId = userInfo?.open_id || 'unknown';

      // Step 5: Store token
      const now = Date.now();
      const storedToken: StoredUAToken = {
        userOpenId,
        appId,
        accessToken: result.token.accessToken,
        refreshToken: result.token.refreshToken,
        expiresAt: now + result.token.expiresIn * 1000,
        refreshExpiresAt: now + result.token.refreshExpiresIn * 1000,
        scope: result.token.scope,
        grantedAt: now,
      };
      setStoredToken(ctiHome, storedToken);

      // Step 6: Update MCP config
      updateMcpUserToken(result.token.accessToken, appId, appSecret);

      // Step 7: Send success card
      await this.sendCard(chatId, buildAuthSuccessCard());
      console.log(`[oauth-manager] Authorization complete for user ${userOpenId}`);
      return true;
    } catch (err) {
      if ((err as Error).name === 'AbortError') return false;
      console.error('[oauth-manager] Device flow error:', err);
      await this.sendCard(chatId, buildAuthFailedCard(`授权失败: ${err instanceof Error ? err.message : err}`)).catch(() => {});
      return false;
    } finally {
      this.flowAbort = null;
    }
  }

  startRefreshTimer(): void {
    if (this.refreshTimer) return;
    this.refreshTimer = setInterval(() => this.checkAndRefresh(), 60_000);
    console.log('[oauth-manager] Refresh timer started (60s interval)');
  }

  stopRefreshTimer(): void {
    if (this.refreshTimer) { clearInterval(this.refreshTimer); this.refreshTimer = null; }
    if (this.flowAbort) { this.flowAbort.abort(); this.flowAbort = null; }
  }

  private async checkAndRefresh(): Promise<void> {
    const { appId, appSecret, domain, ctiHome } = this.config;
    const token = findAnyToken(ctiHome, appId);
    if (!token) return;

    const status = tokenStatus(token);
    if (status === 'valid') return;

    if (status === 'needs_refresh') {
      const refreshed = await refreshToken({ appId, appSecret, domain, refreshToken: token.refreshToken });
      if (refreshed) {
        const now = Date.now();
        const updated: StoredUAToken = {
          ...token,
          accessToken: refreshed.accessToken,
          refreshToken: refreshed.refreshToken,
          expiresAt: now + refreshed.expiresIn * 1000,
          refreshExpiresAt: now + refreshed.refreshExpiresIn * 1000,
        };
        setStoredToken(ctiHome, updated);
        updateMcpUserToken(updated.accessToken, appId, appSecret);
        console.log('[oauth-manager] Token refreshed via background timer');
      } else {
        console.warn('[oauth-manager] Background refresh failed, will need re-auth');
      }
    }
  }

  private async getUserInfo(domain: string, accessToken: string): Promise<{ open_id?: string; name?: string } | null> {
    try {
      const resp = await fetch(`${domain.replace(/\/+$/, '')}/open-apis/authen/v1/user_info`, {
        headers: { Authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(10_000),
      });
      const data = (await resp.json()) as any;
      return data?.data || null;
    } catch { return null; }
  }
}
