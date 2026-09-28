"use strict";
importScripts("watchdog-core.js");
const core = globalThis.ChatGPTErrorWatchdogCore;
const CONFIG = "errorWatchdog:config";
const PREFIX = "errorWatchdog:conversation:";
let queue = Promise.resolve();
function initial() {
  return { enabled: false, count: 0, attempted: [], status: "disabled", detail: "見守りはOFFです。" };
}
async function handle(message, sender) {
  const route = core.route(sender.tab?.url);
  if (!route || route.conversationId !== message.conversationId) throw new Error("会話が切り替わりました。もう一度確認してください。");
  const key = PREFIX + route.conversationId;
  const stored = await chrome.storage.local.get([CONFIG, key]);
  const config = core.normalizeConfig(stored[CONFIG]);
  let session = { ...initial(), ...stored[key] };
  let changed = false;
  let allowed;
  if (message.type === "EW_SET_ENABLED") {
    session.enabled = Boolean(message.enabled);
    session.status = session.enabled ? "watching" : "disabled";
    session.detail = session.enabled ? "明示的なエラーが出たときだけ再開を助けます。" : "見守りを停止しました。";
    changed = true;
  } else if (message.type === "EW_SET_CONFIG") {
    await chrome.storage.local.set({ [CONFIG]: core.normalizeConfig(message.config) });
    return { ok: true, route, session, config: core.normalizeConfig(message.config) };
  } else if (message.type === "EW_CLAIM") {
    // All handlers run serially. Persist BEFORE touching the page so a worker
    // restart or a second tab cannot replay an uncertain send.
    allowed = session.enabled && session.count < config.maxRecoveries &&
      typeof message.errorKey === "string" && message.errorKey.length < 400 &&
      !session.attempted.includes(message.errorKey);
    if (allowed) {
      session.count += 1;
      session.attempted.push(message.errorKey);
      session.status = "recovering";
      session.detail = "エラーからの再開操作中です👏🍵";
      changed = true;
    }
  } else if (message.type === "EW_REPORT") {
    // An in-flight report must never re-enable a conversation after OFF.
    if (session.enabled && (message.status !== session.status || message.detail !== session.detail)) {
      session.status = String(message.status);
      session.detail = String(message.detail || "").slice(0, 500);
      changed = true;
    }
  } else if (message.type !== "EW_STATE") {
    throw new Error("不明な操作です。");
  }
  if (changed) {
    session.updatedAt = Date.now();
    await chrome.storage.local.set({ [key]: session });
  }
  const warn = ["blocked", "paused", "error"].includes(session.status);
  await chrome.action.setBadgeText({ tabId: sender.tab.id, text: !session.enabled ? "" : warn ? "!" : "ON" });
  await chrome.action.setBadgeBackgroundColor({ tabId: sender.tab.id, color: warn ? "#d97706" : "#0f766e" });
  return { ok: true, route, session, config, allowed };
}
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (!message?.type?.startsWith("EW_")) return;
  const run = queue.then(() => handle(message, sender));
  queue = run.catch(() => {});
  run.then(respond, error => respond({ ok: false, error: String(error.message || error) }));
  return true;
});
