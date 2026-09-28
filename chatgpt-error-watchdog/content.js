(function () {
  "use strict";
  const core = globalThis.ChatGPTErrorWatchdogCore;
  const dom = globalThis.ChatGPTErrorWatchdogDOM;
  const SHUTDOWN = "chatgpt-error-watchdog:shutdown";
  document.dispatchEvent(new Event(SHUTDOWN));
  let alive = true;
  let timer;
  let running = false;
  let observed = null;
  let observedAt = 0;
  let observedProgress = "";
  let lastInteraction = 0;
  let fillingPrompt = false;
  let rememberedRoute = null;
  const DETAILS = {
    disabled: "見守りはOFFです。",
    watching: "見守り中です。通常の回答終了では何も送りません。",
    settling: "一時的なエラーを検出しました。設定した待ち時間の後に再開します。",
    generating: "応答中です。停止ボタンが消えるまで待ちます。",
    draft: "入力中の文章・添付ファイルを保護しています。入力欄が空になるまで待ちます。",
    blocked: "自動再開できない表示、または操作欄を確認できない状態です。画面を確認してください。",
    paused: "このエラーへの操作は実行済み、または回数上限です。重複送信せず待っています。",
    recovering: "再開をお願いしています👏🍵",
    sent: "再開操作後の画面変化を確認しました👏🍵　見守りを続けます。"
  };
  function shutdown() {
    alive = false;
    clearInterval(timer);
    document.removeEventListener(SHUTDOWN, shutdown);
  }
  document.addEventListener(SHUTDOWN, shutdown);
  // BFCache-restored pages must be able to resume their read-only polling.
  window.addEventListener("pagehide", () => { clearInterval(timer); });
  window.addEventListener("pageshow", () => { if (alive) startTimer(); });
  for (const event of ["input", "keydown", "paste", "drop"]) {
    document.addEventListener(event, e => {
      if (e.isTrusted && !fillingPrompt && e.target.closest?.('form, #prompt-textarea, [contenteditable="true"]')) lastInteraction = Date.now();
    }, true);
  }
  function sameRoute(id) { return alive && core.route(location.href)?.conversationId === id; }
  async function call(type, values = {}, id = core.route(location.href)?.conversationId) {
    if (!alive || !id) throw new Error("監視対象の会話ではありません。");
    try {
      const result = await chrome.runtime.sendMessage({ type, conversationId: id, ...values });
      if (!result?.ok) throw new Error(result?.error || "拡張への接続を確認できませんでした。");
      return result;
    } catch (error) {
      if (/extension context invalidated/i.test(String(error.message || error))) shutdown();
      throw error;
    }
  }
  async function report(status, detail = DETAILS[status], id) {
    return call("EW_REPORT", { status, detail }, id);
  }
  function decision(snap, state, stableMs) {
    return core.decide({ ...snap, ...state.config, enabled: state.session.enabled,
      count: state.session.count, attempted: state.session.attempted.includes(snap.errorKey),
      stableMs, userBusy: Date.now() - lastInteraction < 10000 });
  }
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  async function until(predicate, timeout = 7000) {
    const deadline = Date.now() + timeout;
    while (alive && Date.now() < deadline) {
      if (predicate()) return true;
      await wait(150);
    }
    return false;
  }
  function fill(input, value) {
    fillingPrompt = true;
    try {
      input.focus();
      if (input instanceof HTMLTextAreaElement || input instanceof HTMLInputElement) {
        const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(proto, "value").set.call(input, value);
      } else {
        const range = document.createRange();
        range.selectNodeContents(input);
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
        if (!document.execCommand?.("insertText", false, value)) input.textContent = value;
      }
      input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
    } finally {
      fillingPrompt = false;
    }
  }
  async function recover(snap, action, id) {
    // Recheck after the persistent claim; UI/user state can change during awaits.
    const claim = await call("EW_CLAIM", { errorKey: snap.errorKey }, id);
    if (!claim.allowed || !sameRoute(id)) return;
    const current = await call("EW_STATE", {}, id);
    if (!current.session.enabled || !sameRoute(id)) return;
    const fresh = dom.snapshot(document);
    const guarded = decision(fresh, { ...current, session: { ...current.session,
      count: Math.max(0, current.session.count - 1), attempted: [] } }, Number.MAX_SAFE_INTEGER);
    if (fresh.errorKey !== snap.errorKey || fresh.progress !== snap.progress || guarded.action !== action) {
      await report("paused", "操作直前に画面または入力欄が変わりました。自動送信を見送りました。", id);
      return;
    }
    if (action === "retry") {
      fresh.retry.click();
      const started = await until(() => {
        if (!sameRoute(id)) return false;
        const next = dom.snapshot(document);
        return !next.error && (next.generating || next.turnCount > fresh.turnCount);
      });
      await report(started ? "sent" : "paused", started ? DETAILS.sent : "Retryは1回押しましたが、再開を確認できませんでした。画面を確認してください。", id);
      return;
    }
    const prompt = core.prompt(fresh.error.kind);
    fill(fresh.input, prompt);
    const ready = await until(() => sameRoute(id) && Boolean(dom.send(document)), 2500);
    if (!ready || !sameRoute(id)) throw new Error("送信ボタンを確認できません。再開文は入力欄に残しています。");
    const latestState = await call("EW_STATE", {}, id);
    const beforeSend = dom.snapshot(document);
    if (!sameRoute(id) || !latestState.session.enabled || beforeSend.errorKey !== fresh.errorKey || beforeSend.generating || beforeSend.attachments ||
      Date.now() - lastInteraction < 10000 || dom.composerText(beforeSend.input).trim() !== prompt) {
      throw new Error("入力欄または会話の状態が変わったため送信を見送りました。再開文を確認してください。");
    }
    const send = dom.send(document);
    if (!send) throw new Error("送信ボタンが見つかりません。");
    send.click();
    const submitted = await until(() => {
      if (!sameRoute(id)) return false;
      const next = dom.snapshot(document);
      // A cleared composer alone is not proof of a sent message.
      return next.userCount > fresh.userCount;
    });
    await report(submitted ? "sent" : "paused", submitted ? DETAILS.sent : "再開依頼の送信結果を確認できません。重複を避けるため再送せず待っています。", id);
  }
  async function tick() {
    if (!alive || running) return;
    running = true;
    const route = core.route(location.href);
    try {
      if (!route) { observed = null; return; }
      if (rememberedRoute !== route.conversationId) {
        observed = null;
        rememberedRoute = route.conversationId;
      }
      const state = await call("EW_STATE", {}, route.conversationId);
      if (!state.session.enabled || !sameRoute(route.conversationId)) { observed = null; return; }
      const snap = dom.snapshot(document);
      const key = snap.errorKey;
      if (observed !== key || observedProgress !== snap.progress) {
        observed = key;
        observedProgress = snap.progress;
        observedAt = Date.now();
      }
      const next = decision(snap, state, Date.now() - observedAt);
      if (next.action === "wait") {
        const detail = next.status === "paused" && state.session.status === "paused"
          ? state.session.detail : DETAILS[next.status];
        await report(next.status, detail, route.conversationId);
      }
      else await recover(snap, next.action, route.conversationId);
    } catch (error) {
      if (alive && route && sameRoute(route.conversationId)) {
        await report("error", String(error.message || error), route.conversationId).catch(() => {});
      }
    } finally { running = false; }
  }
  function startTimer() {
    clearInterval(timer);
    timer = setInterval(() => { void tick(); }, 2000);
    void tick();
  }
  chrome.runtime.onMessage.addListener((message, _sender, respond) => {
    if (!["EW_STATUS", "EW_ENABLE", "EW_DISABLE", "EW_CONFIG"].includes(message?.type)) return;
    const route = core.route(location.href);
    if (!route) { respond({ ok: false, error: "ChatGPTの会話を開いてください。" }); return; }
    (async () => {
      if (message.type === "EW_ENABLE" && message.config) await call("EW_SET_CONFIG", { config: message.config });
      if (message.type === "EW_ENABLE" || message.type === "EW_DISABLE") {
        observed = null;
        return call("EW_SET_ENABLED", { enabled: message.type === "EW_ENABLE" });
      }
      if (message.type === "EW_CONFIG") return call("EW_SET_CONFIG", { config: message.config });
      return call("EW_STATE");
    })().then(respond, error => respond({ ok: false, error: String(error.message || error) }));
    return true;
  });
  startTimer();
})();
