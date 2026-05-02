// POST /api/grade-skk1
//
// 1級建築施工管理技士 第二次検定 勉強会 (oisi/benkyokai-skk1) の
// 答案を Copilot Studio 「建設サポート」 bot へ Direct Line 経由で投げて
// 採点・添削コメントを返す薄いプロキシ。
//
// Request body:
//   {
//     "questionId": "q1" | "q2-1" | "q2-2" | "q2-3"
//                 | "q4-1" | "q4-2" | "q4-3" | "q4-4",
//     "answer":    string  // q1 以外
//     "answers":   { overview, q1a, q1b, q2 }  // q1 用 (任意)
//   }
//
// Response (200):
//   {
//     "questionId": "...",
//     "verdict":    string,  // bot reply (currently same as raw)
//     "raw":        string   // bot reply
//   }
//
// 環境変数:
//   COPILOT_DIRECTLINE_SECRET  Direct Line シークレット (Azure Portal で登録)

const { app } = require('@azure/functions');
const { getQuestion } = require('./questions');
const { askBot, HttpUpstreamError } = require('./directLineClient');

const ALLOWED_ORIGIN = 'https://manual.kensetsu-total.support';
const FALLBACK_ORIGIN = 'http://localhost:4280'; // SWA CLI emulator
const BOT_USER_ID = 'skk1-grader-user';

function corsHeaders(origin) {
  const allow =
    origin === ALLOWED_ORIGIN || origin === FALLBACK_ORIGIN
      ? origin
      : ALLOWED_ORIGIN;
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

    const questionId = payload?.questionId;
    if (typeof questionId !== 'string' || !questionId) {
      return jsonResponse(400, { error: 'questionId is required' }, origin);
    }
    const question = getQuestion(questionId);
    if (!question) {
      return jsonResponse(
        400,
        { error: `Unknown questionId: ${questionId}` },
        origin,
      );
    }

    // 答案存在チェック
    if (question.parts) {
      const ans = payload.answers || {};
      const filled = question.parts.some(
        (p) => typeof ans[p.key] === 'string' && ans[p.key].trim().length > 0,
      );
      if (!filled) {
        return jsonResponse(
          400,
          { error: '少なくとも1つの欄に解答を入力してください。' },
          origin,
        );
      }
    } else {
      if (
        typeof payload.answer !== 'string' ||
        payload.answer.trim().length === 0
      ) {
        return jsonResponse(
          400,
          { error: '解答が空です。記入してから採点を依頼してください。' },
          origin,
        );
      }
    }

    const secret = process.env.COPILOT_DIRECTLINE_SECRET;
    if (!secret) {
      context.error?.(
        'COPILOT_DIRECTLINE_SECRET is not configured on this Function App',
      );
      return jsonResponse(
        503,
        {
          error:
            'Copilot 接続情報が未設定です。管理者に連絡してください (DIRECTLINE_SECRET unset)',
        },
        origin,
      );
    }

    const prompt = buildPrompt(question, payload);
    context.log?.(
      `grade-skk1: questionId=${questionId} promptLen=${prompt.length}`,
    );

    try {
      const { text } = await askBot(secret, prompt, BOT_USER_ID, context);
      if (!text || text.trim().length === 0) {
        return jsonResponse(
          502,
          { error: 'Bot returned empty reply' },
          origin,
        );
      }
      return jsonResponse(
        200,
        { questionId, verdict: text, raw: text },
        origin,
      );
    } catch (e) {
      if (e instanceof HttpUpstreamError) {
        context.error?.(`grade-skk1 upstream error: ${e.status} ${e.message}`);
        return jsonResponse(e.status, { error: e.message }, origin);
      }
      context.error?.(`grade-skk1 unexpected error: ${e?.stack || e}`);
      return jsonResponse(
        500,
        { error: 'Internal error while contacting bot' },
        origin,
      );
    }
  },
});
