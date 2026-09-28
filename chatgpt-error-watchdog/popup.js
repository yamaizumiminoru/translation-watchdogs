/* global chrome, ChatGPTErrorWatchdogCore */
"use strict";

(() => {
  const core = globalThis.ChatGPTErrorWatchdogCore;
  const elements = Object.fromEntries([
    "status-card", "status-label", "status-detail", "recovery-count", "toggle",
    "notice", "settings-form", "grace-seconds", "max-recoveries", "save"
  ].map(id => [id, document.getElementById(id)]));

  const labels = {
    disabled: ["見守りはお休み中", "neutral"],
    watching: ["エラーを見守り中 👀", "good"],
    settling: ["エラーの継続を確認中", "waiting"],
    generating: ["応答中・待機中", "good"],
    draft: ["入力内容を保護して待機中", "waiting"],
    blocked: ["確認が必要です", "waiting"],
    recovering: ["復旧しています 🙏", "waiting"],
    sent: ["復旧操作を行いました 👏🍵", "good"],
    paused: ["自動復旧を休止中", "waiting"],
    error: ["状態を確認できません", "error"]
  };

  let tabId = null;
  let current = null;
  let config = core.normalizeConfig(core.DEFAULTS);
  let dirty = false;
  let busy = false;
  let polling = false;
  let reachable = false;

  function notice(message = "", isError = false) {
    elements.notice.textContent = message;
    elements.notice.dataset.error = String(isError);
  }

  function updateControls() {
    const usable = reachable && Boolean(current?.route?.conversationId);
    elements.toggle.disabled = busy || !usable;
    elements.toggle.dataset.enabled = String(Boolean(current?.session?.enabled));
    elements.toggle.textContent = current?.session?.enabled ? "この会話の見守りを止める" : "この会話を見守る 👀";
    elements.save.disabled = busy || !reachable || !dirty;
    elements["grace-seconds"].disabled = busy;
    elements["max-recoveries"].disabled = busy;
  }

  function applyState(response) {
    current = response;
    reachable = true;
    config = core.normalizeConfig(response.config || config);
    const session = response.session || {};
    const [label, tone] = labels[session.status] || ["状態を確認中…", "neutral"];
    elements["status-label"].textContent = label;
    elements["status-card"].dataset.tone = tone;
    elements["status-detail"].textContent = session.detail || (session.enabled
      ? "明示的なエラーが出たときだけ、復旧をお手伝いします。"
      : "この会話で見守りを始めると、明示的なエラーにだけ反応します。");
    if (!response.route?.conversationId) {
      elements["status-detail"].textContent = "ChatGPTの会話を開いてから、このポップアップを開いてください。";
    }
    elements["recovery-count"].textContent = `自動復旧 ${Number(session.count) || 0} / ${config.maxRecoveries} 回`;
    if (!dirty) {
      elements["grace-seconds"].value = String(config.graceSeconds);
      elements["max-recoveries"].value = String(config.maxRecoveries);
    }
    updateControls();
  }

  function showError(error) {
    reachable = false;
    elements["status-label"].textContent = "このタブに接続できません";
    elements["status-card"].dataset.tone = "error";
    elements["status-detail"].textContent = "ChatGPTの会話タブを開いてください。インストール・更新直後なら、そのタブを一度再読み込みしてください。";
    notice(error?.message || String(error), true);
    updateControls();
  }

  async function request(type, extra = {}) {
    if (tabId === null) throw new Error("対象のChatGPTタブがありません。");
    const response = await chrome.tabs.sendMessage(tabId, { type, ...extra });
    if (!response?.ok) throw new Error(response?.error || "Watchdogから応答がありません。");
    return response;
  }

  async function refresh() {
    if (busy || polling || tabId === null) return;
    polling = true;
    try {
      const response = await request("EW_STATUS");
      if (!busy) {
        const recovered = !reachable;
        applyState(response);
        if (recovered) notice();
      }
    } catch (error) {
      if (!busy) showError(error);
    } finally {
      polling = false;
    }
  }

  elements.toggle.addEventListener("click", async () => {
    if (busy || !reachable || !current?.route?.conversationId) return;
    busy = true;
    updateControls();
    notice();
    try {
      applyState(await request(current.session?.enabled ? "EW_DISABLE" : "EW_ENABLE"));
    } catch (error) {
      showError(error);
    } finally {
      busy = false;
      updateControls();
    }
  });

  elements["settings-form"].addEventListener("input", () => {
    dirty = true;
    notice();
    updateControls();
  });

  elements["settings-form"].addEventListener("submit", async event => {
    event.preventDefault();
    if (busy || !reachable || !elements["settings-form"].reportValidity()) return;
    busy = true;
    updateControls();
    try {
      const updated = core.normalizeConfig({
        ...config,
        graceSeconds: Number(elements["grace-seconds"].value),
        maxRecoveries: Number(elements["max-recoveries"].value)
      });
      const response = await request("EW_CONFIG", { config: updated });
      dirty = false;
      applyState(response);
      notice("設定を保存しました。");
    } catch (error) {
      showError(error);
    } finally {
      busy = false;
      updateControls();
    }
  });

  async function init() {
    elements["grace-seconds"].value = String(config.graceSeconds);
    elements["max-recoveries"].value = String(config.maxRecoveries);
    try {
      const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!active?.id || !/^https:\/\/chatgpt\.com(?:\/|$)/i.test(active.url || "")) {
        throw new Error("ChatGPTの会話タブを選択してください。");
      }
      tabId = active.id;
      await refresh();
    } catch (error) {
      showError(error);
    }
  }

  void init();
  const interval = setInterval(() => { void refresh(); }, 2000);
  window.addEventListener("pagehide", () => clearInterval(interval), { once: true });
})();
