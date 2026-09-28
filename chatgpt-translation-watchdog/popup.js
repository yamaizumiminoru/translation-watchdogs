(function setupPopup() {
  "use strict";

  const core = globalThis.ChatGPTTranslationWatchdogCore;
  const elements = {
    statusDot: document.querySelector("#status-dot"),
    statusLabel: document.querySelector("#status-label"),
    statusDetail: document.querySelector("#status-detail"),
    counter: document.querySelector("#counter"),
    toggle: document.querySelector("#toggle"),
    nudge: document.querySelector("#nudge"),
    rollover: document.querySelector("#rollover"),
    prompt: document.querySelector("#prompt"),
    completionPrompt: document.querySelector("#completion-prompt"),
    terminalErrorPrompt: document.querySelector("#terminal-error-prompt"),
    maxNudges: document.querySelector("#max-nudges"),
    settleSeconds: document.querySelector("#settle-seconds"),
    silentStallSeconds: document.querySelector("#silent-stall-seconds"),
    deliveryTimeoutSeconds: document.querySelector("#delivery-timeout-seconds"),
    completionMarker: document.querySelector("#completion-marker"),
    projectName: document.querySelector("#project-name"),
    repositoryUrl: document.querySelector("#repository-url"),
    rolloverEnabled: document.querySelector("#rollover-enabled"),
    stopOnTerminalError: document.querySelector("#stop-on-terminal-error"),
    save: document.querySelector("#save"),
    resetCount: document.querySelector("#reset-count"),
    message: document.querySelector("#message")
  };

  let activeTabId = null;
  let current = null;

  function formConfig() {
    return core.normalizeConfig({
      prompt: elements.prompt.value,
      completionPrompt: elements.completionPrompt.value,
      terminalErrorPrompt: elements.terminalErrorPrompt.value,
      maxNudges: elements.maxNudges.value,
      settleSeconds: elements.settleSeconds.value,
      silentStallSeconds: elements.silentStallSeconds.value,
      deliveryTimeoutSeconds: elements.deliveryTimeoutSeconds.value,
      completionMarker: elements.completionMarker.value,
      projectName: elements.projectName.value,
      repositoryUrl: elements.repositoryUrl.value,
      rolloverEnabled: elements.rolloverEnabled.checked,
      stopOnTerminalError: elements.stopOnTerminalError.checked
    });
  }

  function fillConfig(config) {
    const value = core.normalizeConfig(config);
    elements.prompt.value = value.prompt;
    elements.completionPrompt.value = value.completionPrompt;
    elements.terminalErrorPrompt.value = value.terminalErrorPrompt;
    elements.maxNudges.value = value.maxNudges;
    elements.settleSeconds.value = value.settleSeconds;
    elements.silentStallSeconds.value = value.silentStallSeconds;
    elements.deliveryTimeoutSeconds.value = value.deliveryTimeoutSeconds;
    elements.completionMarker.value = value.completionMarker;
    elements.projectName.value = value.projectName;
    elements.repositoryUrl.value = value.repositoryUrl;
    elements.rolloverEnabled.checked = value.rolloverEnabled;
    elements.stopOnTerminalError.checked = value.stopOnTerminalError;
  }

  function showMessage(text, isError = false) {
    elements.message.textContent = text;
    elements.message.classList.toggle("error", isError);
  }

  async function send(message) {
    if (!activeTabId) throw new Error("ChatGPTのタブが見つかりません。");
    const response = await chrome.tabs.sendMessage(activeTabId, message);
    if (!response?.ok) throw new Error(response?.error || "操作に失敗しました。");
    current = response;
    render();
    return response;
  }

  function statusClass(status) {
    if (["generating"].includes(status)) return "busy";
    if (["interrupted", "stuck_timeout", "retrying", "rollover"].includes(status)) return "warn";
    if (["error", "paused"].includes(status)) return "error";
    if (["armed", "waiting", "settling", "sent", "complete", "stopped_error"].includes(status)) return "on";
    return "";
  }

  function statusLabel(status) {
    return ({
      disabled: "監視OFF",
      armed: "見守り中",
      waiting: "待機中",
      settling: "停止確認中",
      generating: "翻訳中",
      interrupted: "接続中断・待機中",
      stuck_timeout: "応答固着",
      retrying: "送信を再試行中",
      sent: "再開依頼済み",
      rollover: "新スレへ引き継ぎ中",
      complete: "翻訳完了",
      stopped_error: "エラー終了",
      paused: "安全停止",
      error: "要確認"
    })[status] || "状態確認中";
  }

  function render() {
    if (!current) return;
    const { route, session, snapshot } = current;
    const inConversation = route?.kind === "conversation";
    const enabled = Boolean(session?.enabled);
    const status = session?.status || "disabled";
    elements.statusDot.className = `status-dot ${statusClass(status)}`;
    elements.statusLabel.textContent = statusLabel(status);
    elements.statusDetail.textContent = session?.detail || "状態を確認できませんでした。";
    elements.counter.textContent = `再開 ${session?.nudgeCount || 0}/${current.config?.maxNudges || 0} 回 ・ 新スレ引き継ぎ ${session?.rolloverCount || 0} 回`;
    elements.toggle.textContent = enabled ? "見守りを止める" : "このスレを見守る";
    elements.toggle.classList.toggle("primary", !enabled);
    elements.toggle.disabled = !inConversation;
    const stuckTimeout = status === "stuck_timeout";
    elements.nudge.textContent = stuckTimeout
      ? "停止して労って続ける🙏"
      : "今すぐ労って続けて🙏";
    elements.nudge.classList.toggle("danger-outline", stuckTimeout);
    elements.nudge.disabled = !inConversation || (Boolean(snapshot?.generating) && !stuckTimeout);
    elements.rollover.disabled = !inConversation || !route?.projectSlug;
  }

  async function initialize() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || !tab.url?.startsWith("https://chatgpt.com/")) {
      throw new Error("ChatGPTの会話タブを開いてから使ってください。");
    }
    activeTabId = tab.id;
    current = await send({ type: "GET_STATUS" });
    fillConfig(current.config);
    render();
  }

  elements.toggle.addEventListener("click", async () => {
    try {
      showMessage("");
      if (current?.session?.enabled) await send({ type: "DISABLE" });
      else await send({ type: "ENABLE", config: formConfig() });
    } catch (error) {
      showMessage(error.message, true);
    }
  });

  elements.nudge.addEventListener("click", async () => {
    const stuckTimeout = current?.session?.status === "stuck_timeout";
    if (stuckTimeout) {
      const accepted = confirm(
        `ChatGPTは停止ボタンを表示していますが、${current?.config?.silentStallSeconds || 180}秒以上、本文・ツール履歴が変化していません。現在の応答を停止し、労い＋再開メッセージを送ります。よろしいですか？`
      );
      if (!accepted) return;
    }
    try {
      showMessage("");
      await send({
        type: stuckTimeout ? "RECOVER_STUCK_TIMEOUT" : "NUDGE_NOW",
        config: formConfig()
      });
      showMessage(stuckTimeout
        ? "固着した応答を停止し、労い＋再開依頼を送りました👏🍵"
        : "労い＋再開依頼を送りました👏🍵");
    } catch (error) {
      showMessage(error.message, true);
    }
  });

  elements.rollover.addEventListener("click", async () => {
    const accepted = confirm(
      "現在のスレを容量上限扱いにして、同じ『翻訳』プロジェクトの新しいスレへ引き継ぎメッセージを送ります。よろしいですか？"
    );
    if (!accepted) return;
    try {
      showMessage("");
      await send({ type: "ROLLOVER_NOW", config: formConfig() });
      window.close();
    } catch (error) {
      showMessage(error.message, true);
    }
  });

  elements.save.addEventListener("click", async () => {
    try {
      await send({ type: "SAVE_CONFIG", config: formConfig() });
      fillConfig(current.config);
      showMessage("設定を保存しました。");
    } catch (error) {
      showMessage(error.message, true);
    }
  });

  elements.resetCount.addEventListener("click", async () => {
    try {
      await send({ type: "RESET_COUNT" });
      showMessage("再開回数を0に戻しました。");
    } catch (error) {
      showMessage(error.message, true);
    }
  });

  initialize().catch(error => {
    fillConfig(core.DEFAULTS);
    elements.statusLabel.textContent = "ChatGPTタブが必要です";
    elements.statusDetail.textContent = error.message;
    elements.statusDot.className = "status-dot error";
    elements.toggle.disabled = true;
    elements.nudge.disabled = true;
    elements.rollover.disabled = true;
    showMessage(error.message, true);
  });
})();
