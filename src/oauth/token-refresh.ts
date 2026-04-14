/**
 * Refresh an OAuth user_access_token via refresh_token grant.
 */

export interface RefreshResult {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  refreshExpiresIn: number;
  scope: string;
}

function resolveTokenEndpoint(domain: string): string {
  return `${domain.replace(/\/+$/, '')}/open-apis/authen/v2/oauth/token`;
}

const refreshLock = new Map<string, Promise<RefreshResult | null>>();

export async function refreshToken(params: {
  appId: string;
  appSecret: string;
  domain: string;
  refreshToken: string;
}): Promise<RefreshResult | null> {
  const key = `${params.appId}:${params.refreshToken.slice(0, 8)}`;
  const existing = refreshLock.get(key);
  if (existing) return existing;

  const promise = doRefresh(params);
  refreshLock.set(key, promise);
  promise.finally(() => refreshLock.delete(key));
  return promise;
}

async function doRefresh(params: {
  appId: string;
  appSecret: string;
  domain: string;
  refreshToken: string;
}): Promise<RefreshResult | null> {
  try {
    const endpoint = resolveTokenEndpoint(params.domain);
    const resp = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: params.refreshToken,
        client_id: params.appId,
        client_secret: params.appSecret,
      }).toString(),
      signal: AbortSignal.timeout(15_000),
    });

    const data = (await resp.json()) as Record<string, unknown>;
    if (data.error || !data.access_token) {
      console.warn(`[token-refresh] Failed: ${data.error ?? data.error_description ?? 'no access_token'}`);
      return null;
    }

    console.log('[token-refresh] Token refreshed successfully');
    return {
      accessToken: data.access_token as string,
      refreshToken: (data.refresh_token as string) ?? params.refreshToken,
      expiresIn: (data.expires_in as number) ?? 7200,
      refreshExpiresIn: (data.refresh_token_expires_in as number) ?? 604800,
      scope: (data.scope as string) ?? '',
    };
  } catch (err) {
    console.warn('[token-refresh] Error:', err instanceof Error ? err.message : err);
    return null;
  }
}
