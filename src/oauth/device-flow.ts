/**
 * OAuth 2.0 Device Authorization Grant (RFC 8628) for Feishu.
 *
 * Two-step flow:
 *   1. requestDeviceAuthorization — obtains device_code + user_code
 *   2. pollDeviceToken — polls until user authorises, rejects, or code expires
 *
 * Ported from openclaw-lark (MIT).
 */

export interface DeviceAuthResponse {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string;
  expiresIn: number;
  interval: number;
}

export interface DeviceFlowTokenData {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  refreshExpiresIn: number;
  scope: string;
}

export type DeviceFlowResult =
  | { ok: true; token: DeviceFlowTokenData }
  | { ok: false; error: string; message: string };

function resolveEndpoints(domain: string) {
  const base = domain.replace(/\/+$/, '');
  let accountsBase = base;
  try {
    const parsed = new URL(base);
    if (parsed.hostname.startsWith('open.')) {
      accountsBase = `${parsed.protocol}//${parsed.hostname.replace(/^open\./, 'accounts.')}`;
    }
  } catch { /* fallback */ }
  return {
    deviceAuthorization: `${accountsBase}/oauth/v1/device_authorization`,
    token: `${base}/open-apis/authen/v2/oauth/token`,
  };
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(timer); reject(new DOMException('Aborted', 'AbortError')); }, { once: true });
  });
}

export async function requestDeviceAuthorization(params: {
  appId: string;
  appSecret: string;
  domain: string;
  scope?: string;
}): Promise<DeviceAuthResponse> {
  const { appId, appSecret, domain } = params;
  const endpoints = resolveEndpoints(domain);

  // If no scope specified, don't send scope param — Feishu will grant all app-authorized scopes.
  // Always ensure offline_access is included when scope is specified.
  let scope = params.scope ?? '';
  const sendScope = scope || ''; // empty = all app scopes
  if (sendScope && !sendScope.includes('offline_access')) {
    scope = `${sendScope} offline_access`;
  } else if (!sendScope) {
    scope = ''; // don't send scope param at all
  }

  const basicAuth = Buffer.from(`${appId}:${appSecret}`).toString('base64');
  const body = new URLSearchParams({ client_id: appId });
  if (scope) body.set('scope', scope);

  console.log(`[device-flow] Requesting device authorization, scope="${scope}"`);

  const resp = await fetch(endpoints.deviceAuthorization, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: `Basic ${basicAuth}` },
    body: body.toString(),
    signal: AbortSignal.timeout(15_000),
  });

  const text = await resp.text();
  let data: Record<string, unknown>;
  try { data = JSON.parse(text); } catch {
    throw new Error(`Device authorization failed: HTTP ${resp.status} – ${text.slice(0, 200)}`);
  }

  if (!resp.ok || data.error) {
    throw new Error(`Device authorization failed: ${(data.error_description as string) ?? data.error ?? 'Unknown'}`);
  }

  return {
    deviceCode: data.device_code as string,
    userCode: data.user_code as string,
    verificationUri: data.verification_uri as string,
    verificationUriComplete: (data.verification_uri_complete as string) ?? (data.verification_uri as string),
    expiresIn: (data.expires_in as number) ?? 240,
    interval: (data.interval as number) ?? 5,
  };
}

export async function pollDeviceToken(params: {
  appId: string;
  appSecret: string;
  domain: string;
  deviceCode: string;
  interval: number;
  expiresIn: number;
  signal?: AbortSignal;
}): Promise<DeviceFlowResult> {
  const { appId, appSecret, domain, deviceCode, expiresIn, signal } = params;
  let interval = params.interval;
  const endpoints = resolveEndpoints(domain);
  const deadline = Date.now() + expiresIn * 1000;
  let attempts = 0;

  while (Date.now() < deadline && attempts < 200) {
    attempts++;
    if (signal?.aborted) return { ok: false, error: 'expired_token', message: 'Cancelled' };

    await sleep(interval * 1000, signal);

    let data: Record<string, unknown>;
    try {
      const resp = await fetch(endpoints.token, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
          device_code: deviceCode,
          client_id: appId,
          client_secret: appSecret,
        }).toString(),
      });
      data = (await resp.json()) as Record<string, unknown>;
    } catch (err) {
      console.warn(`[device-flow] Poll network error: ${err}`);
      interval = Math.min(interval + 1, 60);
      continue;
    }

    const error = data.error as string | undefined;

    if (!error && data.access_token) {
      console.log('[device-flow] Token obtained successfully');
      return {
        ok: true,
        token: {
          accessToken: data.access_token as string,
          refreshToken: (data.refresh_token as string) ?? '',
          expiresIn: (data.expires_in as number) ?? 7200,
          refreshExpiresIn: (data.refresh_token_expires_in as number) ?? 604800,
          scope: (data.scope as string) ?? '',
        },
      };
    }

    if (error === 'authorization_pending') continue;
    if (error === 'slow_down') { interval = Math.min(interval + 5, 60); continue; }
    if (error === 'access_denied') return { ok: false, error: 'access_denied', message: '用户拒绝了授权' };
    if (error === 'expired_token' || error === 'invalid_grant') return { ok: false, error: 'expired_token', message: '授权码已过期' };

    return { ok: false, error: 'expired_token', message: (data.error_description as string) ?? error ?? 'Unknown' };
  }

  return { ok: false, error: 'expired_token', message: '授权超时' };
}
