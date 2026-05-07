/* 大石建設 社内対策講座 アクセス認証ゲート
 * 対象: /oisi/benkyokai/, /oisi/benkyokai-skk1/, /oisi/benkyokai-skk2/
 * 方式: ID/PW + SHA-256 ハッシュ照合 + 5回失敗30秒ロック
 * 配置: /oisi/_gate.js（各 index.html の <head> 末尾で <script src="../_gate.js" defer></script> 参照）
 */
(function () {
  'use strict';

  // ===== 設定 =====
  var SALT = 'oisi-benkyokai-2026-05-07';
  // 想定ハッシュ = SHA-256("oisi-benkyokai-2026-05-07:Oisi:5241")
  var EXPECTED_HASH = 'bdf165c19f878496873c7f407f756068e377abad8dec158a32902fcdaad1dc3f';
  var TOKEN_KEY = 'oisi-benkyokai-token';
  var FAIL_KEY = 'oisi-benkyokai-fail';      // {count: N, until: epoch_ms}
  var MAX_FAIL = 5;
  var LOCK_MS = 30 * 1000;

  // ===== すでに認証済みなら何もしない =====
  if (sessionStorage.getItem(TOKEN_KEY) === '1') {
    return;
  }

  // ===== 本体を即座に隠す（DOMContentLoaded前にbody要素があるかは保証されないので、html自体に当てる） =====
  var hideStyle = document.createElement('style');
  hideStyle.id = 'oisi-gate-hide-style';
  hideStyle.textContent = 'html.oisi-gate-locked > body { visibility: hidden !important; }';
  document.head.appendChild(hideStyle);
  document.documentElement.classList.add('oisi-gate-locked');

  // ===== オーバーレイ構築 =====
  function buildOverlay() {
    var styleEl = document.createElement('style');
    styleEl.textContent = [
      '#oisi-gate-overlay {',
      '  position: fixed; inset: 0; z-index: 2147483647;',
      '  background: linear-gradient(135deg, #1A3A5C 0%, #2E6BA6 60%, #74B2E0 100%);',
      '  display: flex; align-items: center; justify-content: center;',
      '  font-family: "Hiragino Sans", "Yu Gothic", "Meiryo", sans-serif;',
      '  color: #1A1A1A; visibility: visible !important;',
      '}',
      '#oisi-gate-card {',
      '  background: #fff; border-radius: 12px; padding: 32px 28px 28px;',
      '  width: min(420px, 92vw); box-shadow: 0 12px 36px rgba(0,0,0,0.25);',
      '}',
      '#oisi-gate-card h1 {',
      '  font-size: 18px; font-weight: 700; margin: 0 0 6px; color: #1A3A5C;',
      '  letter-spacing: 0.02em;',
      '}',
      '#oisi-gate-card .sub {',
      '  font-size: 12px; color: #666; margin: 0 0 20px;',
      '}',
      '#oisi-gate-card .row { margin-bottom: 14px; }',
      '#oisi-gate-card label {',
      '  display: block; font-size: 12px; color: #2E6BA6; font-weight: 600;',
      '  margin-bottom: 6px;',
      '}',
      '#oisi-gate-card input {',
      '  width: 100%; padding: 10px 12px; font-size: 15px;',
      '  border: 1.5px solid #C5DDE9; border-radius: 6px; outline: none;',
      '  background: #F2F8FC; transition: border-color 0.15s, background 0.15s;',
      '}',
      '#oisi-gate-card input:focus { border-color: #74B2E0; background: #fff; }',
      '#oisi-gate-card input:disabled { background: #F0F0F0; color: #999; cursor: not-allowed; }',
      '#oisi-gate-card button {',
      '  width: 100%; padding: 11px 12px; margin-top: 6px;',
      '  background: #74B2E0; color: #fff; font-size: 15px; font-weight: 700;',
      '  border: none; border-radius: 6px; cursor: pointer;',
      '  transition: background 0.15s;',
      '}',
      '#oisi-gate-card button:hover:not(:disabled) { background: #5A9BC7; }',
      '#oisi-gate-card button:disabled { background: #CCCCCC; cursor: not-allowed; }',
      '#oisi-gate-msg {',
      '  margin-top: 12px; min-height: 20px; font-size: 13px;',
      '  color: #b00020; text-align: center;',
      '}',
      '#oisi-gate-msg.lock { color: #2E6BA6; }',
      '@keyframes oisiGateShake {',
      '  0%, 100% { transform: translateX(0); }',
      '  20% { transform: translateX(-8px); }',
      '  40% { transform: translateX(8px); }',
      '  60% { transform: translateX(-6px); }',
      '  80% { transform: translateX(6px); }',
      '}',
      '#oisi-gate-card.shake { animation: oisiGateShake 0.4s ease; }',
      '#oisi-gate-card .footer {',
      '  margin-top: 18px; padding-top: 14px; border-top: 1px solid #F0F0F0;',
      '  font-size: 11px; color: #999; text-align: center;',
      '}'
    ].join('\n');
    document.head.appendChild(styleEl);

    var overlay = document.createElement('div');
    overlay.id = 'oisi-gate-overlay';
    overlay.innerHTML = [
      '<form id="oisi-gate-card" autocomplete="off">',
      '  <h1>大石建設 社内対策講座 アクセス認証</h1>',
      '  <p class="sub">ID と パスワード を入力してください。</p>',
      '  <div class="row">',
      '    <label for="oisi-gate-id">ID</label>',
      '    <input id="oisi-gate-id" type="text" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" />',
      '  </div>',
      '  <div class="row">',
      '    <label for="oisi-gate-pw">パスワード</label>',
      '    <input id="oisi-gate-pw" type="password" autocomplete="off" />',
      '  </div>',
      '  <button type="submit" id="oisi-gate-submit">ログイン</button>',
      '  <div id="oisi-gate-msg"></div>',
      '  <div class="footer">大石建設 / 1級施工管技 社内対策講座</div>',
      '</form>'
    ].join('\n');
    document.body.appendChild(overlay);

    var form = document.getElementById('oisi-gate-card');
    var idInput = document.getElementById('oisi-gate-id');
    var pwInput = document.getElementById('oisi-gate-pw');
    var submitBtn = document.getElementById('oisi-gate-submit');
    var msgEl = document.getElementById('oisi-gate-msg');

    var lockTimer = null;

    function readFailState() {
      try {
        var raw = sessionStorage.getItem(FAIL_KEY);
        if (!raw) return { count: 0, until: 0 };
        var obj = JSON.parse(raw);
        return {
          count: typeof obj.count === 'number' ? obj.count : 0,
          until: typeof obj.until === 'number' ? obj.until : 0
        };
      } catch (e) {
        return { count: 0, until: 0 };
      }
    }
    function writeFailState(s) {
      sessionStorage.setItem(FAIL_KEY, JSON.stringify(s));
    }
    function clearFailState() {
      sessionStorage.removeItem(FAIL_KEY);
    }

    function setLockedUI(remainSec) {
      idInput.disabled = true;
      pwInput.disabled = true;
      submitBtn.disabled = true;
      msgEl.classList.add('lock');
      msgEl.textContent = '5回失敗しました。あと ' + remainSec + ' 秒お待ちください。';
    }
    function setUnlockedUI() {
      idInput.disabled = false;
      pwInput.disabled = false;
      submitBtn.disabled = false;
      msgEl.classList.remove('lock');
      msgEl.textContent = '';
      idInput.focus();
    }

    function startLockCountdown() {
      if (lockTimer) {
        clearInterval(lockTimer);
        lockTimer = null;
      }
      function tick() {
        var s = readFailState();
        var remain = s.until - Date.now();
        if (remain <= 0) {
          clearFailState();
          if (lockTimer) { clearInterval(lockTimer); lockTimer = null; }
          setUnlockedUI();
          return;
        }
        setLockedUI(Math.ceil(remain / 1000));
      }
      tick();
      lockTimer = setInterval(tick, 250);
    }

    // 起動時にロック状態チェック
    var initState = readFailState();
    if (initState.until > Date.now()) {
      startLockCountdown();
    } else {
      // 期限切れの古い情報は掃除
      if (initState.until !== 0) clearFailState();
      setTimeout(function () { idInput.focus(); }, 50);
    }

    async function sha256Hex(text) {
      var enc = new TextEncoder();
      var buf = await crypto.subtle.digest('SHA-256', enc.encode(text));
      var bytes = new Uint8Array(buf);
      var out = '';
      for (var i = 0; i < bytes.length; i++) {
        out += bytes[i].toString(16).padStart(2, '0');
      }
      return out;
    }

    function shakeCard() {
      form.classList.remove('shake');
      // reflow して再アニメ
      void form.offsetWidth;
      form.classList.add('shake');
    }

    function passAuth() {
      sessionStorage.setItem(TOKEN_KEY, '1');
      clearFailState();
      // オーバーレイ撤去 → 本体表示
      var ov = document.getElementById('oisi-gate-overlay');
      if (ov && ov.parentNode) ov.parentNode.removeChild(ov);
      var hs = document.getElementById('oisi-gate-hide-style');
      if (hs && hs.parentNode) hs.parentNode.removeChild(hs);
      document.documentElement.classList.remove('oisi-gate-locked');
    }

    function failAuth() {
      var s = readFailState();
      s.count = (s.count || 0) + 1;
      if (s.count >= MAX_FAIL) {
        s.until = Date.now() + LOCK_MS;
        writeFailState(s);
        startLockCountdown();
      } else {
        s.until = 0;
        writeFailState(s);
        msgEl.classList.remove('lock');
        msgEl.textContent = 'ID または パスワードが違います。（残り ' + (MAX_FAIL - s.count) + ' 回）';
        shakeCard();
        pwInput.value = '';
        pwInput.focus();
      }
    }

    form.addEventListener('submit', async function (ev) {
      ev.preventDefault();
      // 念のためロック中チェック
      var s = readFailState();
      if (s.until > Date.now()) return;

      var id = (idInput.value || '').trim();
      var pw = pwInput.value || '';
      if (!id || !pw) {
        msgEl.classList.remove('lock');
        msgEl.textContent = 'ID と パスワードを入力してください。';
        shakeCard();
        return;
      }

      submitBtn.disabled = true;
      try {
        var hash = await sha256Hex(SALT + ':' + id + ':' + pw);
        if (hash === EXPECTED_HASH) {
          passAuth();
        } else {
          failAuth();
        }
      } catch (e) {
        msgEl.classList.remove('lock');
        msgEl.textContent = '認証処理でエラーが発生しました（' + (e && e.message ? e.message : 'unknown') + '）';
      } finally {
        // ロック中でなければボタン戻す
        var cur = readFailState();
        if (cur.until <= Date.now()) {
          submitBtn.disabled = false;
        }
      }
    });
  }

  // body 出来てから組み立て
  if (document.body) {
    buildOverlay();
  } else {
    document.addEventListener('DOMContentLoaded', buildOverlay, { once: true });
  }
})();
