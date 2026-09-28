(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.ChatGPTErrorWatchdogCore = api;
})(globalThis, function () {
  "use strict";
  const DEFAULTS = Object.freeze({ graceSeconds: 5, maxRecoveries: 10 });
  function normalizeConfig(value = {}) {
    const integer = (x, fallback, min, max) => Number.isFinite(Number(x))
      ? Math.max(min, Math.min(max, Math.floor(Number(x)))) : fallback;
    return {
      graceSeconds: integer(value.graceSeconds ?? 5, 5, 5, 300),
      maxRecoveries: integer(value.maxRecoveries ?? 10, 10, 1, 50)
    };
  }
  function route(url) {
    try {
      const parsed = new URL(url);
      if (parsed.origin !== "https://chatgpt.com") return null;
      const match = parsed.pathname.match(/^\/(?:g\/[^/]+\/)?c\/([a-z0-9-]+)\/?$/i);
      return match ? { conversationId: match[1].toLowerCase() } : null;
    } catch { return null; }
  }
  function hash(text) {
    let value = 0x811c9dc5;
    for (const ch of String(text)) value = Math.imul(value ^ ch.charCodeAt(0), 0x01000193);
    return (value >>> 0).toString(16);
  }
  function compact(text) { return String(text || "").replace(/\s+/g, " ").trim(); }
  const BLOCKED = /rate.?limit|too many requests|usage limit|maximum length|unusual activity|verify you are human|log in|sign in|captcha|content policy|利用上限|回数制限|会話.{0,10}上限|ログイン|認証|不審な|ポリシー/i;
  // Anchored UI labels, not arbitrary prose containing an error phrase.
  const ERRORS = [
    ["timeout", /^Message delivery timed out\.?\s*(?:Please try again\.?)?$/i],
    ["interrupted", /^Connection interrupted\.?\s*(?:Waiting for the complete answer\.?)?$/i],
    ["network", /^(?:A network error occurred|Network error)\.?\s*(?:Please try again\.?)?$/i],
    ["generic", /^Something went wrong\.?\s*(?:Please try again\.?)?$/i],
    ["generic", /^Error in message stream\.?$/i],
    ["thinking", /^Thinking failed\.?$/i],
    ["stream", /^(?:Stream cache expired|Resume stream unavailable)\.?$/i],
    ["generic", /^There was an error generating a response\.?\s*(?:Please try again\.?)?$/i],
    ["timeout", /^メッセージ(?:の)?(?:配信|送信).{0,12}タイムアウト(?:しました)?[。.]?(?:\s*もう一度お試しください[。.]?)?$/],
    ["interrupted", /^接続が中断されました[。.]?(?:\s*完全な回答を待っています[。.]?)?$/],
    ["network", /^ネットワークエラー(?:が発生しました)?[。.]?(?:\s*もう一度お試しください[。.]?)?$/],
    ["generic", /^(?:問題|エラー)が発生しました[。.]?\s*(?:もう一度お試しください|再試行してください)[。.]?$/]
  ];
  function classify(text) {
    const value = compact(text);
    if (BLOCKED.test(value)) return "blocked";
    return ERRORS.find(([, pattern]) => pattern.test(value))?.[0] || null;
  }
  function prompt(kind) {
    const explanation = {
      timeout: "配信がタイムアウトしたようです。",
      interrupted: "接続が途中で切れたようです。",
      network: "通信エラーが出たようです。",
      thinking: "思考処理が失敗したようです。",
      generic: "一時的なエラーが出たようです。"
    }[kind] || "一時的なエラーが出たようです。";
    return `ここまでありがとう、おつかれさまです👏🍵　${explanation} 直前の依頼と既存の指示を保ち、すでにできた部分は重複させず、未完了のところから続けてください🙏`;
  }
  function decide(state) {
    if (!state.enabled) return { action: "wait", status: "disabled" };
    if (!state.error) return { action: "wait", status: state.generating ? "generating" : "watching" };
    if (state.error.kind === "blocked") return { action: "wait", status: "blocked" };
    if (state.draft || state.attachments || state.userBusy) return { action: "wait", status: "draft" };
    const streamRetry = state.error.kind === "stream";
    if (streamRetry && state.lastRole !== "assistant") return { action: "wait", status: "blocked" };
    const retry = state.lastRole === "user" || streamRetry;
    if (retry && !state.retryReady) return { action: "wait", status: "blocked" };
    if (!retry && state.generating) return { action: "wait", status: "generating" };
    if (!retry && !state.composerReady) return { action: "wait", status: "blocked" };
    if (state.count >= state.maxRecoveries || state.attempted) return { action: "wait", status: "paused" };
    if (!Number.isFinite(state.stableMs) || state.stableMs < state.graceSeconds * 1000) {
      return { action: "wait", status: "settling" };
    }
    return { action: retry ? "retry" : "prompt", status: "recovering" };
  }
  return { DEFAULTS, normalizeConfig, route, hash, compact, classify, prompt, decide };
});
