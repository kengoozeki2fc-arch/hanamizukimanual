// POST /api/grade-skk1        — 会話作成 + メッセージ送信開始 (即時 202 で conversationId 返却)
// POST /api/grade-skk1-poll   — 指定 conversationId の activities を polling して bot 応答抽出
//
// 1級建築施工管理技士 第二次検定 勉強会 (oisi/benkyokai-skk1) の答案を
// Copilot Studio 「1級施工管技 採点エージェント (cr746_agent)」へ
// Power Platform API 経由で投げて採点・添削コメントを返すプロキシ。
//
// 認証: ROPC (gemba-bot アカウント)。詳細は ./copilotAuth.js
//
// なぜ2段階か:
//   SWA managed Functions の HTTP 応答ハードリミットが 45 秒。
//   一方 Copilot Studio 新エージェント (cr746_agent / DynamicPlan型) は
//   POST /conversations/{id} に対し 60 秒前後 / 47KB を一括返却するケースがあり、
//   1リクエストで完結させると SWA フロントが 500 "Backend call failure" を返す。
//   そこで:
//     1. /api/grade-skk1       会話作成 + sendMessage を発火 (Promise.race で先勝ち)
//     2. /api/grade-skk1-poll  send Promise (引継) と GET /activities polling 並走
//   と分け、各レスポンスを 45 秒以内に収める。
//
// 重要な実装ポイント:
//   - sendMessage の fetch を AbortController で打ち切ると Power Platform 側の
//     bot 処理も中断される (実測)。よって abort せず Promise を生かしたまま race。
//   - Step1 の sendMessage Promise を module-level Map (inflightSends) に登録、
//     Step2 が同一 Functions プロセス内なら同じ Promise を引き継いで await することで、
//     bot 処理の完走を確実に待ち受ける。
//
// 流れ:
//   1. ROPC で Power Platform Access Token 取得 (warm キャッシュ)
//   2. POST /conversations  会話作成
//   3. POST /conversations/{id}  メッセージ送信開始
//      - Promise.race(sendPromise, pollPromise, deadline 40s)
//      - 40秒以内に bot 応答 activity が拾えれば 200 で verdict を直接返す
//      - 拾えなければ 202 + { conversationId, status:"pending" } を返す
//        (sendPromise は inflightSends に登録された状態で background 継続)
//   4. クライアントは pending なら /api/grade-skk1-poll を 1.5秒間隔で投げる
//      - Functions は inflightSends から sendPromise 引継 + GET /activities polling
//      - 取れたら 200、未取得なら 202 + status:"pending" で繰り返し誘導
//
// Request body (POST /api/grade-skk1):
//   {
//     "questionId": "q1" | "q2-1" | "q2-2" | "q2-3"
//                 | "q4-1" | "q4-2" | "q4-3" | "q4-4",
//     "answer":    string  // q1 以外
//     "answers":   { overview, q1a, q1b, q2 }  // q1 用
//   }
//
// Response (POST /api/grade-skk1):
//   200 { "questionId": "...", "verdict": string, "raw": string, "conversationId": "..." }
//   202 { "questionId": "...", "conversationId": "...", "status": "pending" }
//
// Request body (POST /api/grade-skk1-poll):
//   { "questionId": "...", "conversationId": "...", "watermark": "..." (任意) }
//
// Response (POST /api/grade-skk1-poll):
//   200 { "questionId": "...", "verdict": string, "raw": string, "watermark": "..." }
//   202 { "questionId": "...", "conversationId": "...", "watermark": "...", "status": "pending" }
//
// 環境変数:
//   SPO_TENANT_ID / SPO_CLIENT_ID / SPO_CLIENT_SECRET
//   COPILOT_BOT_USERNAME / COPILOT_BOT_PASSWORD
//   COPILOT_ENDPOINT

const { app } = require('@azure/functions');
const { getQuestion } = require('./questions');
const {
  getAccessToken,
  getCopilotBase,
  CopilotAuthError,
} = require('./copilotAuth');
const gradeStore = require('./gradeStore');

const ALLOWED_ORIGIN = 'https://manual.kensetsu-total.support';
const FALLBACK_ORIGIN = 'http://localhost:4280'; // SWA CLI emulator
// 採点ページが置かれている全オリジン。manual(本家) と sekokan-ai(静的コピー内製化)。
const ALLOWED_ORIGINS = new Set([
  ALLOWED_ORIGIN,
  FALLBACK_ORIGIN,
  'https://sekokan-ai.kensetsu-total.support',
]);
const API_VERSION = '2022-03-01-preview';

// SWA managed Functions の応答上限が 45 秒。各レスポンスは 40 秒で打ち切る。
const SWA_HARD_LIMIT_MS = 45_000;
// 初回 POST /conversations/{id} sendMessage の自前打ち切り (これ以内に応答あれば直接返す)
const SEND_RESPONSE_BUDGET_MS = 35_000;
// /grade-skk1-poll 1呼び出しあたりの polling 全体タイムアウト
const POLL_TOTAL_BUDGET_MS = 35_000;
// /grade-skk1 ハンドラ全体の最大滞在時間 (会話作成 + sendMessage 待機 + polling 1回分)
const ENDPOINT_BUDGET_MS = 40_000;
// /grade-skk1 内の send 後 in-flight polling 用バジェット
// (sendがブロックして帰ってきた時点で残り時間を全部割り当てる)
const POLL_INTERVAL_MS = 1500;
// Activities 1回 GET の fetch タイムアウト
const POLL_FETCH_TIMEOUT_MS = 10_000;
// 会話作成 fetch タイムアウト
const CREATE_TIMEOUT_MS = 15_000;

function corsHeaders(origin) {
  const allow = ALLOWED_ORIGINS.has(origin) ? origin : ALLOWED_ORIGIN;
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '600',
    Vary: 'Origin',
  };
}

function jsonResponse(status, body, origin) {
  return {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...corsHeaders(origin),
    },
    body: JSON.stringify(body),
  };
}

function buildPrompt(question, payload) {
  const lines = [];
  lines.push('【採点依頼】');
  lines.push(`問題：${question.title}`);
  lines.push(question.body);
  lines.push('');
  lines.push('受験者の解答：');
  if (question.parts) {
    const ans = payload.answers || {};
    for (const part of question.parts) {
      const v = (ans[part.key] || '').trim();
      lines.push(`■ ${part.label}`);
      lines.push(v.length > 0 ? v : '（未記入）');
      lines.push('');
    }
  } else {
    const v = (payload.answer || '').trim();
    lines.push(v.length > 0 ? v : '（未記入）');
    lines.push('');
  }
  lines.push(
    '上記解答について、1級建築施工管理技士 第二次検定の採点者として' +
      '採点・○×評価・改善点を具体的に教えてください。',
  );
  return lines.join('\n');
}

/**
 * 新エージェント(cr746_agent)は DynamicPlan event を多数返してくるが、
 * 採点本文は最後の type=message && from.role=bot && text!=空 の activity に入る。
 * 複数 message があれば登場順で全部 join (実測ではほぼ1件)。
 */
function extractBotMessages(activities) {
  if (!Array.isArray(activities)) return [];
  return activities
    .filter(
      (a) =>
        a &&
        a.type === 'message' &&
        a.from?.role === 'bot' &&
        typeof a.text === 'string' &&
        a.text.trim().length > 0,
    )
    .map((a) => a.text);
}

/**
 * fetch with AbortSignal timeout.
 */
async function fetchWithTimeout(url, options, timeoutMs, log, label) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (e) {
    if (e?.name === 'AbortError') {
      log?.warn?.(
        `${label || 'fetch'} aborted after ${timeoutMs}ms`,
      );
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

async function createConversation(base, accessToken, log) {
  const res = await fetchWithTimeout(
    `${base}/conversations?api-version=${API_VERSION}`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: '{}',
    },
    CREATE_TIMEOUT_MS,
    log,
    'create-conversation',
  );
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    log?.error?.(
      `Copilot conversation create failed: status=${res.status} body=${txt.slice(0, 300)}`,
    );
    const err = new Error('Copilot 会話作成に失敗しました');
    err.status = 502;
    throw err;
  }
  const j = await res.json();
  if (!j.conversationId) {
    const err = new Error('Copilot 会話 ID が取得できません');
    err.status = 502;
    throw err;
  }
  return j.conversationId;
}

/**
 * sendMessage を発行。
 *  - timeoutMs 以内にレスポンスが返ってきたら activities を含む json を返す
 *  - timeoutMs 経過したら abort せず、Promise を捨てて { ok:false, deferred:true }
 *    を返す。fetch Promise は background で走り続け、Power Platform 側の bot 処理を
 *    完走させる。返却された Promise (deferredPromise) を呼び出し側が握って参照する
 *    ことで、Functions ホストが background promise を維持し続ける確率を上げる。
 * 重要: AbortController で切ると Power Platform 側の bot 処理も中断されるため、
 *       deadline に到達した場合は abort せず race で先勝ちさせる方式にする。
 */
// opts:
//   storeQuestionId?: string  指定すると send 完走時に採点本文を gradeStore へ
//                             conversationId キーで保存する (案A の肝)。
//                             この保存は send Promise とは独立した内部 await で
//                             行うため、呼び出し側が send.promise を放置 (即 202
//                             返却) しても、send fetch がイベントループに残って
//                             いる限り完走→ストア書き込みまで到達する。
function startSendMessage(base, accessToken, conversationId, text, log, opts) {
  const controller = new AbortController();
  const storeQuestionId =
    opts && typeof opts.storeQuestionId === 'string'
      ? opts.storeQuestionId
      : null;
  const promise = (async () => {
    try {
      const res = await fetch(
        `${base}/conversations/${conversationId}?api-version=${API_VERSION}`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ activity: { type: 'message', text } }),
          signal: controller.signal,
        },
      );
      if (!res.ok) {
        const txt = await res.text().catch(() => '');
        log?.error?.(
          `Copilot send message failed: status=${res.status} body=${txt.slice(0, 300)}`,
        );
        if (storeQuestionId !== null) {
          await gradeStore
            .putError(
              conversationId,
              storeQuestionId,
              `send failed status=${res.status}`,
              log,
            )
            .catch(() => {});
        }
        return { ok: false, status: res.status };
      }
      const json = await res.json();
      // 案A: send レスポンス本体に同期返却された採点本文をストアへ確実に保存。
      if (storeQuestionId !== null) {
        const msgs = extractBotMessages(json.activities);
        if (msgs.length > 0) {
          const verdict = msgs.join('\n\n').trim();
          const wrote = await gradeStore
            .putDone(conversationId, storeQuestionId, verdict, log)
            .catch(() => false);
          log?.(
            `startSendMessage: store putDone conversationId=${conversationId} verdictLen=${verdict.length} wrote=${wrote}`,
          );
        } else {
          // 完走したのに bot text が無い = 異常。error として残し poll を止める。
          await gradeStore
            .putError(
              conversationId,
              storeQuestionId,
              'send completed but no bot text',
              log,
            )
            .catch(() => {});
          log?.warn?.(
            `startSendMessage: send done but no bot text conversationId=${conversationId}`,
          );
        }
      }
      return { ok: true, json };
    } catch (e) {
      if (e?.name === 'AbortError') {
        // 通常 race の loser として呼ばれた時に発生。Functions が落とされなければ
        // ここまで到達するが Power Platform 側は既に応答済みなので問題なし。
        log?.warn?.(`send-message aborted (loser of race)`);
        return { ok: false, aborted: true };
      }
      log?.error?.(`send-message unexpected: ${e?.stack || e}`);
      if (storeQuestionId !== null) {
        await gradeStore
          .putError(
            conversationId,
            storeQuestionId,
            `send unexpected: ${e?.message || e}`,
            log,
          )
          .catch(() => {});
      }
      return { ok: false, error: e };
    }
  })();
  return { promise, controller };
}

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ============================================================================
// In-flight send Promise を Functions プロセススコープで共有するためのレジストリ。
// /grade-skk1 が起動した sendMessage POST を /grade-skk1-poll でも引き継いで
// await できるようにすることで、Power Platform 側の bot 処理が完走するまで
// HTTP コネクションを維持する。Functions ホストプロセスが warm な間のみ有効
// (cold start で消える前提)。
// ============================================================================
const inflightSends = new Map(); // conversationId -> { promise, startedAt, accessToken }
const INFLIGHT_TTL_MS = 5 * 60 * 1000;

function registerInflightSend(conversationId, promise, accessToken) {
  inflightSends.set(conversationId, {
    promise,
    startedAt: Date.now(),
    accessToken,
  });
  // 完了したら自動掃除（成功失敗どちらでも）
  promise.finally(() => {
    setTimeout(() => {
      const cur = inflightSends.get(conversationId);
      if (cur && cur.promise === promise) inflightSends.delete(conversationId);
    }, 30_000); // 完了後30秒は残してpoll側のlast-chanceに使えるようにする
  });
  // 安全弁: 5分でTTL強制削除
  setTimeout(() => {
    const cur = inflightSends.get(conversationId);
    if (cur && cur.promise === promise) inflightSends.delete(conversationId);
  }, INFLIGHT_TTL_MS);
}

function getInflightSend(conversationId) {
  return inflightSends.get(conversationId);
}

/**
 * GET /activities を deadline (絶対時刻ms) まで polling。
 * 取れたら { messages, watermark } を返す。
 * 取れずに deadline 超えたら { messages: [], watermark } を返す。
 */
async function pollActivitiesUntil(
  base,
  accessToken,
  conversationId,
  initialWatermark,
  deadlineEpochMs,
  log,
) {
  let watermark = initialWatermark || null;
  while (Date.now() < deadlineEpochMs) {
    const remain = deadlineEpochMs - Date.now();
    if (remain <= 0) break;
    const url = watermark
      ? `${base}/conversations/${conversationId}/activities?api-version=${API_VERSION}&watermark=${encodeURIComponent(watermark)}`
      : `${base}/conversations/${conversationId}/activities?api-version=${API_VERSION}`;
    const fetchBudget = Math.min(POLL_FETCH_TIMEOUT_MS, remain);
    let res;
    try {
      res = await fetchWithTimeout(
        url,
        {
          method: 'GET',
          headers: { Authorization: `Bearer ${accessToken}` },
        },
        fetchBudget,
        log,
        'poll-activities',
      );
    } catch (e) {
      log?.warn?.(`poll-activities fetch error: ${e?.message || e}`);
      // 一時的失敗・aborted: ループ継続
      const sleep = Math.min(
        POLL_INTERVAL_MS,
        Math.max(0, deadlineEpochMs - Date.now()),
      );
      if (sleep > 0) await new Promise((r) => setTimeout(r, sleep));
      continue;
    }
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      log?.error?.(
        `poll-activities failed: status=${res.status} body=${txt.slice(0, 300)}`,
      );
      const sleep = Math.min(
        POLL_INTERVAL_MS,
        Math.max(0, deadlineEpochMs - Date.now()),
      );
      if (sleep > 0) await new Promise((r) => setTimeout(r, sleep));
      continue;
    }
    const j = await res.json();
    if (j.watermark) watermark = j.watermark;
    const msgs = extractBotMessages(j.activities);
    if (msgs.length > 0) {
      return { messages: msgs, watermark };
    }
    // インターバル待機 (deadlineを超えない範囲で)
    const sleep = Math.min(
      POLL_INTERVAL_MS,
      Math.max(0, deadlineEpochMs - Date.now()),
    );
    if (sleep > 0) await new Promise((r) => setTimeout(r, sleep));
  }
  return { messages: [], watermark };
}

// ============================================================================
// questionOverride 検証
// ----------------------------------------------------------------------------
// クライアント (例: oisi/benkyokai-skk2) が R5 などサーバー側マスタに無い
// 問題文で採点したい場合、payload に `questionOverride` を載せて送ってくる。
// shape は questions.js の QUESTIONS と同型: { title, body, parts? }
//
// セキュリティ／健全性チェック:
//   - title / body は文字列・長さ上限あり
//   - parts は配列で、各要素は { key, label, placeholder? } の文字列
//   - shape 不正なら null を返し、呼び出し側は getQuestion() フォールバック
//   - LLM プロンプトに混ぜるためログには平文を出さず override使用フラグだけ
// ============================================================================
const OVERRIDE_TITLE_MAX = 200;
const OVERRIDE_BODY_MAX = 5000;
const OVERRIDE_PARTS_MAX = 12;
const OVERRIDE_PART_KEY_MAX = 64;
const OVERRIDE_PART_LABEL_MAX = 300;
const OVERRIDE_PART_PLACEHOLDER_MAX = 300;

function _isNonEmptyString(v, max) {
  return typeof v === 'string' && v.length > 0 && v.length <= max;
}

/**
 * payload.questionOverride を検証する。
 * @returns 妥当な override オブジェクト or null。
 */
function sanitizeQuestionOverride(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (!_isNonEmptyString(raw.title, OVERRIDE_TITLE_MAX)) return null;
  if (!_isNonEmptyString(raw.body, OVERRIDE_BODY_MAX)) return null;
  const out = { title: raw.title, body: raw.body };
  if (raw.parts !== undefined) {
    if (!Array.isArray(raw.parts)) return null;
    if (raw.parts.length === 0) return null;
    if (raw.parts.length > OVERRIDE_PARTS_MAX) return null;
    const parts = [];
    for (const p of raw.parts) {
      if (!p || typeof p !== 'object' || Array.isArray(p)) return null;
      if (!_isNonEmptyString(p.key, OVERRIDE_PART_KEY_MAX)) return null;
      if (!_isNonEmptyString(p.label, OVERRIDE_PART_LABEL_MAX)) return null;
      const part = { key: p.key, label: p.label };
      if (p.placeholder !== undefined) {
        if (typeof p.placeholder !== 'string') return null;
        if (p.placeholder.length > OVERRIDE_PART_PLACEHOLDER_MAX) return null;
        part.placeholder = p.placeholder;
      }
      parts.push(part);
    }
    out.parts = parts;
  }
  return out;
}

/**
 * 答案 payload バリデーション。
 * 戻り値: { ok:true, prompt } または { ok:false, status, error }
 */
function validateAndBuildPrompt(payload, log) {
  const questionId = payload?.questionId;
  if (typeof questionId !== 'string' || !questionId) {
    return { ok: false, status: 400, error: 'questionId is required' };
  }
  // questionOverride を最優先。妥当でなければマスタにフォールバック。
  const override = sanitizeQuestionOverride(payload?.questionOverride);
  let question;
  let usedOverride;
  if (override) {
    question = override;
    usedOverride = true;
  } else {
    if (payload?.questionOverride !== undefined) {
      log?.warn?.(
        `validateAndBuildPrompt: questionOverride present but invalid shape for questionId=${questionId}, fallback to master`,
      );
    }
    question = getQuestion(questionId);
    usedOverride = false;
    if (!question) {
      return {
        ok: false,
        status: 400,
        error: `Unknown questionId: ${questionId}`,
      };
    }
  }
  log?.(
    `validateAndBuildPrompt: questionId=${questionId} override=${usedOverride}`,
  );
  if (question.parts) {
    const ans = payload.answers || {};
    const filled = question.parts.some(
      (p) => typeof ans[p.key] === 'string' && ans[p.key].trim().length > 0,
    );
    if (!filled) {
      return {
        ok: false,
        status: 400,
        error: '少なくとも1つの欄に解答を入力してください。',
      };
    }
  } else {
    if (
      typeof payload.answer !== 'string' ||
      payload.answer.trim().length === 0
    ) {
      return {
        ok: false,
        status: 400,
        error: '解答が空です。記入してから採点を依頼してください。',
      };
    }
  }
  return {
    ok: true,
    questionId,
    question,
    usedOverride,
    prompt: buildPrompt(question, payload),
  };
}

// ============================================================================
// POST /api/grade-skk1
//   会話作成 + メッセージ送信を開始。
//   35秒以内にbot応答が拾えれば 200 で直接返す。
//   拾えなければ 202 + conversationId を返してクライアント polling に任せる。
// ============================================================================
app.http('grade-skk1', {
  methods: ['POST', 'OPTIONS'],
  authLevel: 'anonymous',
  route: 'grade-skk1',
  handler: async (request, context) => {
    const origin = request.headers.get('origin') || '';

    if (request.method === 'OPTIONS') {
      return { status: 204, headers: corsHeaders(origin) };
    }

    let payload;
    try {
      payload = await request.json();
    } catch (e) {
      return jsonResponse(400, { error: 'Invalid JSON body' }, origin);
    }

    const v = validateAndBuildPrompt(payload, context.log?.bind(context));
    if (!v.ok) {
      return jsonResponse(v.status, { error: v.error }, origin);
    }
    const { questionId, prompt, usedOverride } = v;

    const t0 = Date.now();
    context.log?.(
      `grade-skk1: start questionId=${questionId} promptLen=${prompt.length} override=${usedOverride}`,
    );

    let accessToken;
    try {
      accessToken = await getAccessToken(context);
      context.log?.(`grade-skk1: token ok t+${Date.now() - t0}ms`);
    } catch (e) {
      if (e instanceof CopilotAuthError) {
        context.error?.(`grade-skk1 auth error: ${e.message}`);
        return jsonResponse(e.status, { error: e.message }, origin);
      }
      context.error?.(`grade-skk1 auth unexpected: ${e?.stack || e}`);
      return jsonResponse(503, { error: 'Copilot 認証情報設定エラー' }, origin);
    }

    const base = getCopilotBase();

    let conversationId;
    try {
      conversationId = await createConversation(base, accessToken, context);
      context.log?.(
        `grade-skk1: conversation created id=${conversationId} t+${Date.now() - t0}ms`,
      );
    } catch (e) {
      const status = e?.status || 502;
      return jsonResponse(
        status,
        { error: e?.message || 'Copilot 接続エラー' },
        origin,
      );
    }

    // 案A: ストアに pending レコードを先に作る。poll はこのレコードを
    // conversationId キーで読む (インスタンスを跨いでも結果を拾える)。
    await gradeStore
      .putPending(conversationId, questionId, context.log?.bind(context))
      .catch(() => {});

    // sendMessage を background で開始（abort せず最後まで走らせる）
    // Power Platform 側は HTTPコネクションが生きている間 bot 処理を継続するため、
    // クライアント (=Functions) 側で abort してしまうと処理が中断される実測。
    // storeQuestionId を渡すことで、send 完走時 (46〜54秒後) に採点本文を
    // gradeStore へ自動保存する。grade-skk1 が先に 202 を返しても、send fetch が
    // イベントループに残っている限り完走→保存まで到達する。
    const send = startSendMessage(
      base,
      accessToken,
      conversationId,
      prompt,
      context,
      { storeQuestionId: questionId },
    );
    // module-level レジストリに登録: /grade-skk1-poll が同一プロセス内で
    // この Promise を await できるようにする (warm な間のみ有効・ストアの fallback)。
    registerInflightSend(conversationId, send.promise, accessToken);

    // 案A: cr746_agent の send は 46〜54 秒の同期返却型で、SWA 45秒制限を必ず
    // 超える。よって grade-skk1 は send 完走を待たず、ごく短い猶予 (速い完走を
    // 拾うため) だけ様子を見て、間に合わなければ即 202 を返してクライアント poll に
    // 移行する。send fetch はバックグラウンドで継続し、完走時に startSendMessage
    // 内のフックが gradeStore へ verdict を保存する。
    //   - GET /activities polling (pollActivitiesUntil) は cr746_agent では count=0 で
    //     構造的に結果が取れないため grade-skk1 からは廃止した。
    let botMessages = [];
    let watermark = null;

    // 速い完走 (まれに数秒で返るケース) を拾うための短い猶予。
    // ここを長くしても send は通常 ~50秒かかるので意味が薄い。フロント poll に
    // 早く移行させた方がトータルが速い。
    const EARLY_SETTLE_MS = 4000;
    const early = await Promise.race([
      send.promise.then((r) => ({ settled: true, value: r })),
      delay(EARLY_SETTLE_MS).then(() => ({ settled: false })),
    ]);
    if (early.settled) {
      const v = early.value;
      const elapsed = Date.now() - t0;
      if (v?.ok && v.json) {
        context.log?.(
          `grade-skk1: send settled early t+${elapsed}ms activities=${Array.isArray(v.json.activities) ? v.json.activities.length : 0}`,
        );
        botMessages = extractBotMessages(v.json.activities);
        if (v.json.watermark) watermark = v.json.watermark;
      } else {
        context.log?.(
          `grade-skk1: send settled early without bot text t+${elapsed}ms ok=${v?.ok}`,
        );
      }
    } else {
      context.log?.(
        `grade-skk1: send still running after ${EARLY_SETTLE_MS}ms → 202 pending (store経由でpollが拾う)`,
      );
    }

    if (botMessages.length > 0) {
      const text = botMessages.join('\n\n').trim();
      // send promise が走り続けている可能性あるが、Power Platform側は応答済みなので
      // 落としても影響なし。HTTPレスポンス送信後 Promise が放置されると Functions
      // が unhandled rejection 警告を出すので catch を attach しておく。
      send.promise.catch(() => {});
      return jsonResponse(
        200,
        {
          questionId,
          verdict: text,
          raw: text,
          conversationId,
          watermark: watermark || undefined,
        },
        origin,
      );
    }

    // 早期猶予内に決着せず: 202 pending 返却。send fetch はバックグラウンドで
    // 継続し、完走時に gradeStore へ verdict が保存される。
    // send promise は abort しない (Power Platform 側の bot 処理を続行させる)。
    send.promise.catch(() => {});
    context.log?.(
      `grade-skk1: pending t+${Date.now() - t0}ms conversationId=${conversationId}`,
    );
    return jsonResponse(
      202,
      {
        questionId,
        conversationId,
        watermark: watermark || undefined,
        status: 'pending',
        message: '採点処理中。/api/grade-skk1-poll で結果を取得してください。',
      },
      origin,
    );
  },
});

// ============================================================================
// POST /api/grade-skk1-poll
//   conversationId を指定して activities polling。
//   35秒polling して bot text 取れたら 200、取れなければ 202+pending。
// ============================================================================
app.http('grade-skk1-poll', {
  methods: ['POST', 'OPTIONS'],
  authLevel: 'anonymous',
  route: 'grade-skk1-poll',
  handler: async (request, context) => {
    const origin = request.headers.get('origin') || '';

    if (request.method === 'OPTIONS') {
      return { status: 204, headers: corsHeaders(origin) };
    }

    let payload;
    try {
      payload = await request.json();
    } catch (e) {
      return jsonResponse(400, { error: 'Invalid JSON body' }, origin);
    }
    const questionId =
      typeof payload?.questionId === 'string' ? payload.questionId : null;
    const conversationId =
      typeof payload?.conversationId === 'string'
        ? payload.conversationId
        : null;
    const inWatermark =
      typeof payload?.watermark === 'string' ? payload.watermark : null;
    if (!conversationId) {
      return jsonResponse(
        400,
        { error: 'conversationId is required' },
        origin,
      );
    }

    const t0 = Date.now();
    context.log?.(
      `grade-skk1-poll: start conversationId=${conversationId} watermark=${inWatermark || 'n/a'}`,
    );

    let accessToken;
    try {
      accessToken = await getAccessToken(context);
    } catch (e) {
      if (e instanceof CopilotAuthError) {
        context.error?.(`grade-skk1-poll auth error: ${e.message}`);
        return jsonResponse(e.status, { error: e.message }, origin);
      }
      context.error?.(`grade-skk1-poll auth unexpected: ${e?.stack || e}`);
      return jsonResponse(503, { error: 'Copilot 認証情報設定エラー' }, origin);
    }

    const base = getCopilotBase();
    let botMessages = [];
    let watermark = inWatermark || null;

    // ========================================================================
    // 案A 主経路: gradeStore を conversationId キーで読む。
    // send 完走時 (startSendMessage 内) に done+verdict が書かれているので、
    // grade-skk1 と grade-skk1-poll が別インスタンスでも結果を拾える。
    // この poll 呼び出し自体は GET /activities を一切叩かず、ストアを1回読むだけ
    // なので 1〜2秒で完結する (SWA 45秒制限に触れない / フロントが 1.5秒間隔で
    // 繰り返す)。
    // ========================================================================
    const stored = await gradeStore.get(
      conversationId,
      context.log?.bind(context),
    );
    if (stored) {
      context.log?.(
        `grade-skk1-poll: store hit status=${stored.status} verdictLen=${(stored.verdict || '').length} ageMs=${stored.ageMs}`,
      );
      if (stored.status === 'done' && stored.verdict) {
        const text = stored.verdict.trim();
        return jsonResponse(
          200,
          {
            questionId: questionId || stored.questionId || undefined,
            verdict: text,
            raw: text,
            conversationId,
            watermark: watermark || undefined,
          },
          origin,
        );
      }
      if (stored.status === 'error') {
        return jsonResponse(
          502,
          {
            questionId: questionId || stored.questionId || undefined,
            conversationId,
            error: '採点処理でエラーが発生しました。再試行してください。',
          },
          origin,
        );
      }
      // status=pending → そのまま 202 で返す (下の共通 return)
    } else {
      context.log?.(
        `grade-skk1-poll: store miss (未登録 or ストア無効) → inflight fallback`,
      );
    }

    // ========================================================================
    // fallback: ストアが無効 (接続文字列が無い環境) or まだ pending の場合に、
    // 同一プロセス内に走っている send Promise が「完走済み」なら、その同期返却
    // 本文を即拾う。ストア有効時の主経路ではないが、ストア未設定環境でも動く保険。
    // ※ GET /activities polling (pollActivitiesUntil) は cr746_agent では構造的に
    //   結果が取れない (count=0) ため廃止した。
    // ========================================================================
    if (botMessages.length === 0) {
      const inflight = getInflightSend(conversationId);
      if (inflight) {
        // send が「もう完走しているか」だけを非ブロッキングで確認する。
        // ここで send を await し続けると 46〜54 秒かかり SWA 45秒制限に当たるので、
        // 短い猶予 (最大 3 秒) だけ待って、間に合えば拾う。間に合わなければ 202。
        const SETTLE_GRACE_MS = 3000;
        const raceResult = await Promise.race([
          inflight.promise.then((r) => ({ settled: true, value: r })),
          delay(SETTLE_GRACE_MS).then(() => ({ settled: false })),
        ]);
        if (raceResult.settled) {
          const v = raceResult.value;
          if (v?.ok && v.json) {
            botMessages = extractBotMessages(v.json.activities);
            if (v.json.watermark) watermark = v.json.watermark;
          }
          context.log?.(
            `grade-skk1-poll: inflight send settled bot-text=${botMessages.length}`,
          );
        } else {
          context.log?.(
            `grade-skk1-poll: inflight send still running → 202 pending`,
          );
        }
      }
    }

    const elapsed = Date.now() - t0;
    context.log?.(
      `grade-skk1-poll: done t+${elapsed}ms count=${botMessages.length}`,
    );

    if (botMessages.length > 0) {
      const text = botMessages.join('\n\n').trim();
      return jsonResponse(
        200,
        {
          questionId,
          verdict: text,
          raw: text,
          conversationId,
          watermark: watermark || undefined,
        },
        origin,
      );
    }

    return jsonResponse(
      202,
      {
        questionId,
        conversationId,
        watermark: watermark || undefined,
        status: 'pending',
      },
      origin,
    );
  },
});

// ============================================================================
// セコカンAI 自由確認チャット
// ----------------------------------------------------------------------------
// 採点(grade-skk1)と同じ Copilot Studio エージェント・同じ ROPC 認証・同じ
// 2段階ポーリング機構を流用し、採点プロンプトでラップせず「ユーザーの自由質問」
// をそのまま投げて回答を返す。会話を継続したい場合は conversationId を引き継ぐ
// ことでマルチターン対話になる。
//
// POST /api/sekokan-ask
//   Request:  { "message": string, "conversationId"?: string }
//   Response: 200 { answer, raw, conversationId, watermark }
//             202 { conversationId, status:"pending", watermark }
// POST /api/sekokan-ask-poll
//   Request:  { "conversationId": string, "watermark"?: string }
//   Response: 200 { answer, raw, conversationId, watermark }
//             202 { conversationId, status:"pending", watermark }
// ============================================================================

// 採点エージェントを質問応答に向けるための軽い前置き（新規会話の初回のみ付与）。
const ASK_PREAMBLE =
  'あなたは1級建築施工管理技士の試験対策に詳しい現場監督アカデミーAIです。' +
  '以下の質問に、採点ではなく、わかりやすい解説として日本語で回答してください。\n\n';

const MAX_ASK_LEN = 4000;

app.http('sekokan-ask', {
  methods: ['POST', 'OPTIONS'],
  authLevel: 'anonymous',
  route: 'sekokan-ask',
  handler: async (request, context) => {
    const origin = request.headers.get('origin') || '';
    if (request.method === 'OPTIONS') {
      return { status: 204, headers: corsHeaders(origin) };
    }

    let payload;
    try {
      payload = await request.json();
    } catch (e) {
      return jsonResponse(400, { error: 'Invalid JSON body' }, origin);
    }
    const message =
      typeof payload?.message === 'string' ? payload.message.trim() : '';
    const priorConversationId =
      typeof payload?.conversationId === 'string' && payload.conversationId
        ? payload.conversationId
        : null;
    if (!message) {
      return jsonResponse(400, { error: '質問を入力してください。' }, origin);
    }
    if (message.length > MAX_ASK_LEN) {
      return jsonResponse(
        400,
        { error: `質問が長すぎます（最大${MAX_ASK_LEN}文字）。` },
        origin,
      );
    }

    const t0 = Date.now();
    const deadline = t0 + ENDPOINT_BUDGET_MS;

    let accessToken;
    try {
      accessToken = await getAccessToken(context);
    } catch (e) {
      if (e instanceof CopilotAuthError) {
        context.error?.(`sekokan-ask auth error: ${e.message}`);
        return jsonResponse(e.status, { error: e.message }, origin);
      }
      context.error?.(`sekokan-ask auth unexpected: ${e?.stack || e}`);
      return jsonResponse(503, { error: 'Copilot 認証情報設定エラー' }, origin);
    }

    const base = getCopilotBase();

    // conversationId 引継ぎがあればマルチターン継続、無ければ新規会話。
    let conversationId = priorConversationId;
    const isNewConversation = !conversationId;
    if (isNewConversation) {
      try {
        conversationId = await createConversation(base, accessToken, context);
      } catch (e) {
        const status = e?.status || 502;
        return jsonResponse(
          status,
          { error: e?.message || 'Copilot 接続エラー' },
          origin,
        );
      }
    }

    // 新規会話の初回のみ前置きを付与（継続ターンは文脈が残るので素の質問）。
    const text = isNewConversation ? ASK_PREAMBLE + message : message;

    const send = startSendMessage(base, accessToken, conversationId, text, context);
    registerInflightSend(conversationId, send.promise, accessToken);

    let botMessages = [];
    let watermark = null;
    const pollDeadline = deadline - 1000;
    const sendWrapped = send.promise.then((r) => ({ kind: 'send', value: r }));
    const pollPromise = pollActivitiesUntil(
      base,
      accessToken,
      conversationId,
      null,
      pollDeadline,
      context,
    ).then((r) => ({ kind: 'poll', value: r }));
    const deadlinePromise = delay(Math.max(0, deadline - Date.now())).then(
      () => ({ kind: 'deadline' }),
    );

    let timedOut = false;
    while (!timedOut && botMessages.length === 0) {
      const winner = await Promise.race([sendWrapped, pollPromise, deadlinePromise]);
      if (winner.kind === 'deadline') {
        timedOut = true;
        break;
      }
      if (winner.kind === 'send') {
        const v = winner.value;
        if (v?.ok && v.json) {
          botMessages = extractBotMessages(v.json.activities);
          if (v.json.watermark) watermark = v.json.watermark;
          if (botMessages.length > 0) break;
        }
        const next = await Promise.race([pollPromise, deadlinePromise]);
        if (next.kind === 'deadline') {
          timedOut = true;
          break;
        }
        botMessages = next.value.messages;
        if (next.value.watermark) watermark = next.value.watermark;
        break;
      }
      if (winner.kind === 'poll') {
        botMessages = winner.value.messages;
        if (winner.value.watermark) watermark = winner.value.watermark;
        break;
      }
    }

    if (botMessages.length > 0) {
      const answer = botMessages.join('\n\n').trim();
      send.promise.catch(() => {});
      return jsonResponse(
        200,
        { answer, raw: answer, conversationId, watermark: watermark || undefined },
        origin,
      );
    }

    send.promise.catch(() => {});
    pollPromise.catch(() => {});
    return jsonResponse(
      202,
      {
        conversationId,
        watermark: watermark || undefined,
        status: 'pending',
        message: '回答生成中。/api/sekokan-ask-poll で結果を取得してください。',
      },
      origin,
    );
  },
});

app.http('sekokan-ask-poll', {
  methods: ['POST', 'OPTIONS'],
  authLevel: 'anonymous',
  route: 'sekokan-ask-poll',
  handler: async (request, context) => {
    const origin = request.headers.get('origin') || '';
    if (request.method === 'OPTIONS') {
      return { status: 204, headers: corsHeaders(origin) };
    }

    let payload;
    try {
      payload = await request.json();
    } catch (e) {
      return jsonResponse(400, { error: 'Invalid JSON body' }, origin);
    }
    const conversationId =
      typeof payload?.conversationId === 'string' ? payload.conversationId : null;
    const inWatermark =
      typeof payload?.watermark === 'string' ? payload.watermark : null;
    if (!conversationId) {
      return jsonResponse(400, { error: 'conversationId is required' }, origin);
    }

    const t0 = Date.now();
    let accessToken;
    try {
      accessToken = await getAccessToken(context);
    } catch (e) {
      if (e instanceof CopilotAuthError) {
        return jsonResponse(e.status, { error: e.message }, origin);
      }
      context.error?.(`sekokan-ask-poll auth unexpected: ${e?.stack || e}`);
      return jsonResponse(503, { error: 'Copilot 認証情報設定エラー' }, origin);
    }

    const base = getCopilotBase();
    const deadline = Math.min(
      t0 + POLL_TOTAL_BUDGET_MS,
      t0 + (SWA_HARD_LIMIT_MS - 5000),
    );

    const inflight = getInflightSend(conversationId);
    let botMessages = [];
    let watermark = inWatermark || null;

    if (inflight) {
      const sendWrapped = inflight.promise.then((r) => ({ kind: 'send', value: r }));
      const pollWrapped = pollActivitiesUntil(
        base,
        accessToken,
        conversationId,
        watermark,
        deadline,
        context,
      ).then((r) => ({ kind: 'poll', value: r }));
      const deadlineWrapped = delay(Math.max(0, deadline - Date.now())).then(
        () => ({ kind: 'deadline' }),
      );
      while (Date.now() < deadline && botMessages.length === 0) {
        const winner = await Promise.race([sendWrapped, pollWrapped, deadlineWrapped]);
        if (winner.kind === 'deadline') break;
        if (winner.kind === 'send') {
          const v = winner.value;
          if (v?.ok && v.json) {
            botMessages = extractBotMessages(v.json.activities);
            if (v.json.watermark) watermark = v.json.watermark;
            if (botMessages.length > 0) break;
          }
          const next = await Promise.race([pollWrapped, deadlineWrapped]);
          if (next.kind === 'deadline') break;
          botMessages = next.value.messages;
          if (next.value.watermark) watermark = next.value.watermark;
          break;
        }
        if (winner.kind === 'poll') {
          botMessages = winner.value.messages;
          if (winner.value.watermark) watermark = winner.value.watermark;
          break;
        }
      }
    } else {
      const result = await pollActivitiesUntil(
        base,
        accessToken,
        conversationId,
        watermark,
        deadline,
        context,
      );
      botMessages = result.messages;
      if (result.watermark) watermark = result.watermark;
    }

    if (botMessages.length > 0) {
      const answer = botMessages.join('\n\n').trim();
      return jsonResponse(
        200,
        { answer, raw: answer, conversationId, watermark: watermark || undefined },
        origin,
      );
    }

    return jsonResponse(
      202,
      { conversationId, watermark: watermark || undefined, status: 'pending' },
      origin,
    );
  },
});
