// Copilot Studio (Power Platform) authenticated bot 用の薄いクライアント。
//
// 認証方式: ROPC (Resource Owner Password Credentials)
//   POST https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token
//   grant_type=password, scope=https://api.powerplatform.com/CopilotStudio.Copilots.Invoke
//
// 取得した access_token を expires_in - 60 秒までモジュールスコープにキャッシュ。
// Azure Functions の warm 期間内のみ有効でよい (cold start 時は再取得される)。
//
// 環境変数:
//   SPO_TENANT_ID
//   SPO_CLIENT_ID
//   SPO_CLIENT_SECRET
//   COPILOT_BOT_USERNAME   gemba-bot のサインイン UPN
//   COPILOT_BOT_PASSWORD   gemba-bot のパスワード
//   COPILOT_ENDPOINT       例: https://default506cae5ac1514312bc5dfbcf375efa.94.environment.api.powerplatform.com/copilotstudio/dataverse-backed/authenticated/bots/cr746_1/conversations
//
// シークレット類は絶対にログに出さない / レスポンスに混ぜない。

const TOKEN_URL = (tenantId) =>
  `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`;
const SCOPE = 'https://api.powerplatform.com/CopilotStudio.Copilots.Invoke';

let cachedAccessToken = null; // { value, expiresAt }

class CopilotAuthError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function readEnv() {
  const tenantId = process.env.SPO_TENANT_ID;
  const clientId = process.env.SPO_CLIENT_ID;
  const clientSecret = process.env.SPO_CLIENT_SECRET;
  const botUsername = process.env.COPILOT_BOT_USERNAME;
  const botPassword = process.env.COPILOT_BOT_PASSWORD;
  const endpoint = process.env.COPILOT_ENDPOINT;
  const missing = [];
  if (!tenantId) missing.push('SPO_TENANT_ID');
  if (!clientId) missing.push('SPO_CLIENT_ID');
  if (!clientSecret) missing.push('SPO_CLIENT_SECRET');
  if (!botUsername) missing.push('COPILOT_BOT_USERNAME');
  if (!botPassword) missing.push('COPILOT_BOT_PASSWORD');
  if (!endpoint) missing.push('COPILOT_ENDPOINT');
  if (missing.length > 0) {
    throw new CopilotAuthError(
      503,
      `Copilot 認証情報設定エラー: ${missing.join(', ')} 未設定`,
    );
  }
  return { tenantId, clientId, clientSecret, botUsername, botPassword, endpoint };
}

/**
 * COPILOT_ENDPOINT を base / conversations に分解する。
 * 末尾が /conversations でも /conversations/{id} でも対応。
 */
function getCopilotBase() {
  const endpoint = process.env.COPILOT_ENDPOINT || '';
  // /conversations から後ろを落とした URL を base とする
  const base = endpoint.replace(/\/conversations.*$/, '');
  return base;
}

async function getAccessToken(log) {
  if (
    cachedAccessToken &&
    cachedAccessToken.expiresAt > Date.now() + 60_000
  ) {
    return cachedAccessToken.value;
  }
  const env = readEnv();
  const params = new URLSearchParams({
    grant_type: 'password',
    client_id: env.clientId,
    client_secret: env.clientSecret,
    username: env.botUsername,
    password: env.botPassword,
    scope: SCOPE,
  });
  const res = await fetch(TOKEN_URL(env.tenantId), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params,
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    // Azure AD のエラー本文には機微情報は含まれないが、念のため200文字で打ち切り
    log?.error?.(
      `ROPC token request failed: status=${res.status} body=${txt.slice(0, 200)}`,
    );
    throw new CopilotAuthError(503, 'Copilot 認証トークン取得に失敗しました');
  }
  const j = await res.json();
  if (!j.access_token || !j.expires_in) {
    throw new CopilotAuthError(503, 'Copilot 認証トークン応答が不正');
  }
  cachedAccessToken = {
    value: j.access_token,
    expiresAt: Date.now() + j.expires_in * 1000,
  };
  return j.access_token;
}

module.exports = {
  getAccessToken,
  getCopilotBase,
  CopilotAuthError,
};
