(function startTranslationWatchdog() {
  "use strict";

  const core = globalThis.ChatGPTTranslationWatchdogCore;
  if (!core) return;

  const CONFIG_KEY = "translationWatchdog:config";
  const SESSION_PREFIX = "translationWatchdog:session:";
  const PENDING_ROLLOVER_KEY = "translationWatchdog:pendingRollover";
  const ROLLOVER_TTL_MS = 30 * 60 * 1000;

  let config = core.normalizeConfig({});
  let route = core.parseChatGPTLocation(location.href);
  let session = null;
  let tickTimer = null;
  let tickRunning = false;
  let lastUrl = location.href;
  let contextAlive = true;

  const INSTANCE_SHUTDOWN_EVENT = "translation-watchdog:shutdown-previous-instance";

  function stopWatchdogForThisPage() {
    if (!contextAlive) return;
    contextAlive = false;
    if (tickTimer) clearInterval(tickTimer);
    tickTimer = null;
    document.removeEventListener(INSTANCE_SHUTDOWN_EVENT, stopWatchdogForThisPage);
  }

  function stopIfContextInvalidated(error) {
    if (!core.isExtensionContextInvalidated(error)) return false;
    stopWatchdogForThisPage();
    return true;
  }

  document.dispatchEvent(new Event(INSTANCE_SHUTDOWN_EVENT));
  document.addEventListener(INSTANCE_SHUTDOWN_EVENT, stopWatchdogForThisPage);
  window.addEventListener("pagehide", stopWatchdogForThisPage, { once: true });

  const visible = element => {
    if (!element) return false;
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
  };

  function sessionStorageKey(currentRoute = route) {
    return currentRoute?.sessionKey ? `${SESSION_PREFIX}${currentRoute.sessionKey}` : null;
  }

  async function storageGet(keys) {
    try {
      return await chrome.storage.local.get(keys);
    } catch (error) {
      stopIfContextInvalidated(error);
      throw error;
    }
  }

  async function storageSet(values) {
    try {
      return await chrome.storage.local.set(values);
    } catch (error) {
      stopIfContextInvalidated(error);
      throw error;
    }
  }

  async function storageRemove(keys) {
    try {
      return await chrome.storage.local.remove(keys);
    } catch (error) {
      stopIfContextInvalidated(error);
      throw error;
    }
  }

  function defaultSession() {
    return {
      enabled: false,
      nudgeCount: 0,
      rolloverCount: 0,
      completionThanksSent: false,
      terminalErrorThanksSent: false,
      lastRetriedTurnKey: null,
      lastRetriedStreamTurnKey: null,
      lastHandledAssistantKey: null,
      candidateAssistantKey: null,
      candidateSeenAt: 0,
      status: "disabled",
      detail: "監視はOFFです",
      updatedAt: Date.now()
    };
  }

  async function loadState() {
    const key = sessionStorageKey();
    const keys = key ? [CONFIG_KEY, key] : [CONFIG_KEY];
    const stored = await storageGet(keys);
    config = core.normalizeConfig(stored[CONFIG_KEY]);
    session = key ? { ...defaultSession(), ...(stored[key] || {}) } : defaultSession();
  }

  async function saveConfig(nextConfig) {
    config = core.normalizeConfig(nextConfig);
    await storageSet({ [CONFIG_KEY]: config });
    scheduleTick();
    return config;
  }

  async function saveSession(patch) {
    const key = sessionStorageKey();
    session = { ...defaultSession(), ...(session || {}), ...patch, updatedAt: Date.now() };
    if (key) await storageSet({ [key]: session });
    updateBadge(session.status);
    return session;
  }

  function updateBadge(status) {
    if (!contextAlive) return;
    const badgeStatus = {
      disabled: "disabled",
      armed: "armed",
      waiting: "armed",
      settling: "armed",
      generating: "generating",
      interrupted: "interrupted",
      stuck_timeout: "interrupted",
      retrying: "interrupted",
      sent: "sent",
      rollover: "rollover",
      complete: "complete",
      stopped_error: "complete",
      error: "error",
      paused: "error"
    }[status] || "error";
    try {
      const pending = chrome.runtime.sendMessage({ type: "SET_BADGE", status: badgeStatus });
      pending?.catch(error => {
        stopIfContextInvalidated(error);
      });
    } catch (error) {
      stopIfContextInvalidated(error);
    }
  }

  function elementText(element) {
    return String(element?.innerText || element?.textContent || "").trim();
  }

  function normalizedText(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function composerText(composer) {
    return composer instanceof HTMLTextAreaElement || composer instanceof HTMLInputElement
      ? composer.value.trim()
      : elementText(composer);
  }

  function collectTurns() {
    const candidates = Array.from(
      document.querySelectorAll(
        'article[data-testid^="conversation-turn-"], [data-testid^="conversation-turn-"], [data-turn-key]'
      )
    );
    const turnNodes = candidates.filter((node, index) =>
      !candidates.some((other, otherIndex) => otherIndex !== index && other.contains(node))
    );
    const turns = [];
    const turnEntries = turnNodes.flatMap(node => {
      const units = Array.from(node.querySelectorAll('[data-chatgpt-search-unit-key]'))
        .filter(unit => /:(user|assistant)$/i.test(unit.getAttribute('data-chatgpt-search-unit-key') || ''));
      if (units.length < 2) return [{ node }];
      // A single current turn-key can contain both the user and assistant.
      return units.map(unit => ({
        node: unit.parentElement !== node && node.contains(unit.parentElement) &&
          unit.parentElement.querySelectorAll('[data-chatgpt-search-unit-key]').length === 1
          ? unit.parentElement : unit,
        id: `${node.getAttribute('data-turn-key') || node.getAttribute('data-testid')}:${unit.getAttribute('data-chatgpt-search-unit-key')}`
      }));
    });

    for (let index = 0; index < turnEntries.length; index += 1) {
      const { node, id: boundaryId } = turnEntries[index];
      const roleNode = node.matches("[data-message-author-role]")
        ? node
        : node.querySelector("[data-message-author-role]");
      const role = core.inferTurnRole({
        dataTurn: node.getAttribute("data-turn"),
        authorRole: roleNode?.getAttribute("data-message-author-role"),
        hasUserBubble: Boolean(node.querySelector("[data-user-message-bubble]")),
        searchUnitKey: (node.matches('[data-chatgpt-search-unit-key]') ? node : node.querySelector("[data-chatgpt-search-unit-key]"))
          ?.getAttribute("data-chatgpt-search-unit-key")
      });
      if (role !== "assistant" && role !== "user") continue;
      turns.push({
        id: boundaryId || node.getAttribute("data-turn-key") || node.getAttribute("data-testid") || node.id || `${role}-${index}`,
        role,
        text: elementText(roleNode || (role === "user" ? node.querySelector("[data-user-message-bubble]") : null) || node),
        node
      });
    }

    if (turns.length > 0) return turns;

    return Array.from(document.querySelectorAll(
      '[data-message-author-role="user"], [data-message-author-role="assistant"], [data-turn="user"], [data-turn="assistant"]'
    ))
      .map((node, index) => ({
        id: node.closest("article")?.getAttribute("data-testid") || node.id || `${node.getAttribute("data-message-author-role")}-${index}`,
        role: core.normalizeTurnRole(
          node.getAttribute("data-turn"),
          node.getAttribute("data-message-author-role")
        ),
        text: elementText(node),
        node: node.closest('[data-testid^="conversation-turn-"]') || node
      }))
      .filter(turn => turn.role === "assistant" || turn.role === "user");
  }

  function findGeneratingButton() {
    const selectors = [
      '[data-testid="stop-button"]',
      '#composer-submit-button[aria-label*="Stop" i]',
      'button[aria-label="Stop"]',
      'button[aria-label*="Stop answering" i]',
      'button[aria-label*="Stop generating" i]',
      'button[aria-label*="回答を停止"]',
      'button[aria-label*="生成を停止"]'
    ];
    for (const selector of selectors) {
      const found = Array.from(document.querySelectorAll(selector)).find(visible);
      if (found) return found;
    }
    const composer = findComposer();
    const controls = composer?.closest('form, [data-testid="composer"], #thread-bottom-container');
    return Array.from(controls?.querySelectorAll("button") || []).find(button =>
      visible(button) && [button.getAttribute("aria-label"), elementText(button)]
        .some(label => /^(?:Stop|停止)$/.test(String(label || "").trim()))
    ) || null;
  }

  function findComposer() {
    const selectors = [
      "#prompt-textarea",
      '[contenteditable="true"][data-virtualkeyboard]',
      'main [contenteditable="true"]',
      'textarea[placeholder]'
    ];
    for (const selector of selectors) {
      const found = Array.from(document.querySelectorAll(selector)).find(visible);
      if (found) return found;
    }
    return null;
  }

  function findSendButton() {
    const stopButton = findGeneratingButton();
    const selectors = [
      '[data-testid="send-button"]',
      '#composer-submit-button:not([aria-label*="Stop" i])',
      'button[type="submit"][aria-label="Send"]',
      'button[aria-label="Send prompt"]',
      'button[aria-label="Send message"]',
      'button[aria-label*="送信"]'
    ];
    for (const selector of selectors) {
      const found = Array.from(document.querySelectorAll(selector)).find(
        element => element !== stopButton && visible(element) && !element.disabled
      );
      if (found) return found;
    }
    return null;
  }

  function findRetryButton(lastTurn) {
    const node = lastTurn?.node;
    if (!node) return null;
    return Array.from(node.querySelectorAll("button")).find(button => {
      if (!visible(button) || button.closest('.markdown, .whitespace-pre-wrap, pre, code, blockquote')) return false;
      const label = `${button.getAttribute("aria-label") || ""} ${elementText(button)}`.trim();
      return /^(?:Retry|Try again|再試行|もう一度(?:試す|お試しください))$/i.test(label) ||
        /(?:^|\s)(?:Retry|Try again|再試行)(?:\s|$)/i.test(label);
    }) || null;
  }

  function findStreamCacheRetry(lastTurn, retryButton) {
    if (lastTurn?.role !== "assistant" || !retryButton) return null;
    const errorNodes = Array.from(lastTurn.node.querySelectorAll(
      '[role="alert"], [data-testid*="error" i], [data-error-code]'
    ));
    if (errorNodes.some(node => visible(node) && node.contains(retryButton) &&
      !node.closest('.markdown, .whitespace-pre-wrap, pre, code, blockquote') &&
      !node.querySelector('.markdown, .whitespace-pre-wrap, pre, code, blockquote') &&
      core.hasStreamCacheExpiredLabel(elementText(node).replace(/\s*(?:Retry|Try again|再試行)\s*$/i, "")))) {
      return retryButton;
    }
    // The Retry button can be wrapped separately from the error text. Walk
    // only its nearby control rows, never the assistant's rendered prose.
    let row = retryButton.parentElement;
    for (let depth = 0; row && depth < 3 && row !== lastTurn.node; depth += 1, row = row.parentElement) {
      if (row.querySelector('.markdown, .whitespace-pre-wrap, pre, code, blockquote')) break;
      const siblings = Array.from(row.children).filter(node =>
        node !== retryButton && !node.contains(retryButton) && visible(node) &&
        !node.closest('.markdown, .whitespace-pre-wrap, pre, code, blockquote') &&
        !node.querySelector('.markdown, .whitespace-pre-wrap, pre, code, blockquote')
      );
      const directText = Array.from(row.childNodes)
        .filter(node => node.nodeType === Node.TEXT_NODE)
        .map(node => node.textContent || "").join(" ");
      if (siblings.some(node => core.hasStreamCacheExpiredLabel(elementText(node))) ||
          core.hasStreamCacheExpiredLabel(directText)) return retryButton;
    }
    return null;
  }

  function hasThinkingFailureIndicator(lastTurn, hasResponseActions) {
    if (lastTurn?.role !== "assistant" || hasResponseActions) return false;
    return Array.from(lastTurn.node.querySelectorAll("button")).some(button =>
      visible(button) &&
      !button.closest('.markdown, .whitespace-pre-wrap, pre, code, blockquote') &&
      core.hasThinkingFailureLabel(elementText(button))
    );
  }

  function hasAnalysisFailureIndicator(lastTurn, hasResponseActions) {
    if (lastTurn?.role !== "assistant" || hasResponseActions) return false;
    return Array.from(lastTurn.node.querySelectorAll("button")).some(button =>
      visible(button) &&
      !button.closest('.markdown, .whitespace-pre-wrap, pre, code, blockquote') &&
      core.hasAnalysisErrorLabel(elementText(button))
    );
  }

  function currentStatusText(lastAssistant) {
    const liveStatus = Array.from(
      document.querySelectorAll('[role="alert"], [aria-live="assertive"], [data-testid*="error" i]')
    )
      .filter(visible)
      .map(elementText)
      .filter(Boolean)
      .join("\n");
    return `${String(lastAssistant?.text || "")}\n${liveStatus}`.slice(-12000);
  }

  function assistantStructure(lastAssistant) {
    const node = lastAssistant?.node;
    if (!node) {
      return {
        hasToolActivity: false,
        hasResponseActions: false,
        activitySignature: ""
      };
    }

    const activityButtons = Array.from(
      node.querySelectorAll('button[aria-expanded], button[aria-controls]')
    ).filter(visible);
    const hasResponseActions = Array.from(
      node.querySelectorAll(
        '[aria-label="Response actions"], [data-testid="copy-turn-action-button"], button[aria-label="Copy response"], button[aria-label="More actions"]'
      )
    ).some(visible);
    const activitySignature = activityButtons
      .map(button => [
        button.getAttribute("aria-label") || elementText(button),
        button.getAttribute("aria-expanded") || "",
        button.getAttribute("data-testid") || ""
      ].join("|"))
      .join("\n");

    return {
      hasToolActivity: activityButtons.length > 0,
      hasResponseActions,
      activitySignature
    };
  }

  function snapshot() {
    const turns = collectTurns();
    const lastTurn = turns[turns.length - 1] || null;
    const lastAssistant = [...turns].reverse().find(turn => turn.role === "assistant") || null;
    const lastUser = [...turns].reverse().find(turn => turn.role === "user") || null;
    const statusText = currentStatusText(lastAssistant);
    const rawGenerating = Boolean(findGeneratingButton());
    const composer = findComposer();
    const composerReady = Boolean(composer);
    const draftText = composerText(composer);
    const structure = assistantStructure(lastAssistant);
    const thinkingFailed = hasThinkingFailureIndicator(lastTurn, structure.hasResponseActions);
    const analysisFailed = hasAnalysisFailureIndicator(lastTurn, structure.hasResponseActions);
    const assistantKey = core.makeStableTurnKey(lastAssistant);
    const lastTurnKey = core.makeTurnKey(lastTurn);
    const deliveryTimedOut = core.hasDeliveryTimeout(statusText);
    const retryButton = findRetryButton(lastTurn);
    const streamCacheRetry = findStreamCacheRetry(lastTurn, retryButton);
    const streamCacheFailure = Boolean(streamCacheRetry);
    const streamCacheDraftSafe = !draftText || core.hasStreamCacheExpiredLabel(draftText);
    const lastTurnSurfaceText = elementText(lastTurn?.node);
    const retryableSendFailure = lastTurn?.role === "user" &&
      Boolean(retryButton) &&
      core.hasRetryableSendFailure(lastTurnSurfaceText);
    // ChatGPT can leave a visible stop-like control behind after a failed user
    // submission. An explicit error plus Retry on the latest user turn is the
    // stronger signal, so do not let the stale control mask recovery.
    const generating = rawGenerating && !retryableSendFailure && !streamCacheFailure;
    const silentStalled = core.isSilentStallCandidate({
      lastRole: lastTurn?.role,
      generating,
      deliveryTimedOut,
      composerReady,
      hasToolActivity: structure.hasToolActivity,
      analysisFailed,
      hasResponseActions: structure.hasResponseActions
    });
    const observationKey = lastTurnKey
      ? retryableSendFailure
        ? `${lastTurnKey}:retryable-send-failure`
        : `${lastTurnKey}:${core.fnv1a([
          structure.activitySignature,
          structure.hasResponseActions ? "actions" : "no-actions",
          generating ? "generating" : "idle",
          composerReady ? "composer" : "no-composer",
          deliveryTimedOut ? "delivery-timeout" : "no-delivery-timeout",
          thinkingFailed ? "thinking-failed" : "no-thinking-failed",
          analysisFailed ? "analysis-errored" : "no-analysis-error",
          streamCacheFailure ? "stream-cache-expired" : "no-stream-cache-error",
          streamCacheDraftSafe ? "retry-draft-safe" : "draft-protected",
          retryableSendFailure ? "retryable-send-failure" : "no-retryable-send-failure"
        ].join("\n"))}`
      : null;
    return {
      turns,
      lastTurn,
      lastAssistant,
      lastUser,
      assistantKey,
      lastTurnKey,
      observationKey,
      generating,
      composerReady,
      draftText,
      streamCacheFailure,
      streamCacheDraftSafe,
      streamCacheTurnKey: core.makeStableTurnKey(lastTurn),
      retryTurnKey: core.makeStableTurnKey(lastTurn),
      hasToolActivity: structure.hasToolActivity,
      hasResponseActions: structure.hasResponseActions,
      silentStalled,
      interrupted: core.hasTransientInterruption(statusText),
      deliveryTimedOut,
      thinkingFailed,
      analysisFailed,
      retryableSendFailure,
      capacityLimited: core.hasCapacityLimit(statusText),
      terminalErrorBlocked: core.hasTerminalErrorBlocker(lastAssistant?.text),
      completed: core.hasCompletionMarker(lastAssistant?.text, config.completionMarker)
    };
  }

  function setComposerValue(composer, text) {
    composer.focus();
    if (composer instanceof HTMLTextAreaElement || composer instanceof HTMLInputElement) {
      const prototype = composer instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
      if (setter) setter.call(composer, text);
      else composer.value = text;
      composer.dispatchEvent(new Event("input", { bubbles: true }));
      composer.dispatchEvent(new Event("change", { bubbles: true }));
      return;
    }

    composer.textContent = "";
    const paragraph = document.createElement("p");
    paragraph.textContent = text;
    composer.appendChild(paragraph);
    composer.dispatchEvent(new InputEvent("input", {
      bubbles: true,
      inputType: "insertText",
      data: text
    }));
  }

  async function waitFor(predicate, timeoutMs, intervalMs = 100) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const value = predicate();
      if (value) return value;
      await new Promise(resolve => setTimeout(resolve, intervalMs));
    }
    return null;
  }

  async function submitPrompt(text) {
    if (findGeneratingButton()) throw new Error("ChatGPTがまだ応答中なので送信を見送りました。停止後に再試行します。");
    const composer = findComposer();
    if (!composer) throw new Error("入力欄が見つかりません。ChatGPTの画面構造が変わった可能性があります。");
    const existingDraft = composerText(composer);
    if (existingDraft) throw new Error("入力欄に下書きがあるため、自動送信を見送りました。下書きは変更していません。");
    const normalizedPrompt = normalizedText(text);
    const beforeIds = new Set(collectTurns().filter(turn => turn.role === "user").map(turn => turn.id));
    const prefix = normalizedPrompt.slice(0, Math.min(60, normalizedPrompt.length));
    setComposerValue(composer, text);
    const sendButton = await waitFor(findSendButton, 2500);
    if (!sendButton) throw new Error("送信ボタンが有効になりませんでした。メッセージは送っていません。");
    sendButton.click();

    const submitted = await waitFor(() => collectTurns().some(turn =>
      turn.role === "user" && !beforeIds.has(turn.id) &&
      normalizedText(turn.text).startsWith(prefix)
    ), 5000);
    if (!submitted) {
      throw new Error("新しいユーザーメッセージを確認できませんでした。重複防止のため自動再送はしません。");
    }
  }

  async function enableMonitor() {
    if (route.kind !== "conversation") throw new Error("ChatGPTの会話ページで監視を開始してください。");
    const snap = snapshot();
    const recoverTimedOutTurn = snap.deliveryTimedOut && !snap.generating;
    const recoverSilentStall = snap.silentStalled;
    const recoverCurrentTurn = recoverTimedOutTurn || recoverSilentStall || snap.thinkingFailed || snap.streamCacheFailure;
    await saveSession({
      enabled: true,
      lastHandledAssistantKey: snap.generating || recoverCurrentTurn ? null : snap.assistantKey,
      candidateAssistantKey: snap.generating || recoverCurrentTurn ? snap.observationKey : null,
      candidateSeenAt: snap.generating || recoverCurrentTurn ? Date.now() : 0,
      status: snap.generating ? "generating" : recoverCurrentTurn ? "settling" : "armed",
      detail: snap.generating
        ? "応答中です。停止したら労って続きを頼みます👏🍵"
        : recoverTimedOutTurn
          ? `配信タイムアウトを検出しました。${config.deliveryTimeoutSeconds}秒後に続きを頼みます👏🍵`
          : snap.streamCacheFailure
          ? `ストリーム再開エラーを検出しました。${config.deliveryTimeoutSeconds}秒後に画面のRetryを1回だけ押します…`
          : snap.thinkingFailed
            ? `Thinking failedを検出しました。${config.deliveryTimeoutSeconds}秒後に続きを頼みます👏🍵`
          : snap.analysisFailed
            ? `Analysis erroredを検出しました。${config.silentStallSeconds}秒間、本文・ツール履歴に変化がない場合だけ続きを頼みます👏🍵`
          : recoverSilentStall
            ? `最終回答なしで止まった可能性があります。${config.silentStallSeconds}秒変化がなければ続きを頼みます👏🍵`
            : "監視を開始しました。次の応答停止から自動で続きを頼みます。"
    });
    return statusPayload();
  }

  async function disableMonitor(detail = "監視をOFFにしました") {
    await saveSession({ enabled: false, status: "disabled", detail });
    return statusPayload();
  }

  async function nudgeNow(expectedAssistantKey = null) {
    if (route.kind !== "conversation") throw new Error("会話ページで実行してください。");
    const snap = snapshot();
    if (snap.generating) throw new Error("まだ応答中です。完全に止まってから実行してください。");
    if (snap.lastTurn?.role !== "assistant" || !snap.assistantKey ||
        (expectedAssistantKey && snap.assistantKey !== expectedAssistantKey)) {
      throw new Error("対象の応答が変わりました。送信せず画面を再確認してください。");
    }
    if (snap.assistantKey === session.lastHandledAssistantKey) {
      throw new Error("同じ応答への再開依頼はすでに試みました。重複送信しません。");
    }
    if (snap.draftText) throw new Error("入力欄に下書きがあるため、自動送信を見送りました。下書きは変更していません。");
    if (session.nudgeCount >= config.maxNudges) throw new Error("再開回数の上限です。回数をリセットしてください。");
    // Claim before clicking Send: an uncertain UI acknowledgement must never
    // reopen the same assistant turn for another automatic submission.
    await saveSession({
      nudgeCount: session.nudgeCount + 1,
      lastHandledAssistantKey: snap.assistantKey,
      candidateAssistantKey: null,
      candidateSeenAt: 0,
      status: "sending",
      detail: "同じ応答への重複送信を防ぎながら再開依頼を送っています…"
    });
    await submitPrompt(config.prompt);
    await saveSession({
      enabled: true,
      candidateAssistantKey: null,
      candidateSeenAt: 0,
      status: "sent",
      detail: `労い＋再開依頼を送りました👏🍵（${session.nudgeCount}/${config.maxNudges}）`
    });
    return statusPayload();
  }

  async function retryStreamCacheFailure() {
    if (route.kind !== "conversation") throw new Error("会話ページで実行してください。");
    const snap = snapshot();
    const retryButton = findStreamCacheRetry(snap.lastTurn, findRetryButton(snap.lastTurn));
    if (!snap.streamCacheFailure || !retryButton || !snap.streamCacheTurnKey) {
      throw new Error("ストリーム再開エラーのRetry表示が変わりました。操作していません。");
    }
    if (!snap.streamCacheDraftSafe) {
      throw new Error("入力欄の下書きを保護するためRetryを見送りました。");
    }
    if (session.lastRetriedStreamTurnKey === snap.streamCacheTurnKey) {
      throw new Error("同じストリーム再開エラーへのRetryはすでに試みました。");
    }
    if (session.nudgeCount >= config.maxNudges) throw new Error("再開回数の上限です。");
    await saveSession({
      status: "retrying",
      lastRetriedStreamTurnKey: snap.streamCacheTurnKey,
      nudgeCount: session.nudgeCount + 1,
      candidateSeenAt: Date.now(),
      detail: "ストリーム再開エラーのRetryを1回だけ試しています。下書きは変更しません。"
    });
    retryButton.click();
    const resumed = await waitFor(() => {
      const next = snapshot();
      return !next.streamCacheFailure && (next.generating || next.lastTurnKey !== snap.lastTurnKey);
    }, 7000, 150);
    if (!resumed) {
      throw new Error("Retry後の再開を確認できませんでした。同じエラーへのRetryは繰り返しません。");
    }
    await saveSession({
      status: "sent",
      candidateAssistantKey: null,
      candidateSeenAt: 0,
      detail: "ストリーム再開エラーのRetry後、応答再開を確認しました。下書きはそのままです。"
    });
    return statusPayload();
  }

  async function recoverStuckResponse() {
    if (route.kind !== "conversation") throw new Error("会話ページで実行してください。");
    if (session.status !== "stuck_timeout") {
      throw new Error(`${config.silentStallSeconds}秒以上の応答固着をまだ確認できていません。`);
    }
    if (session.nudgeCount >= config.maxNudges) {
      throw new Error("再開回数の上限です。回数をリセットしてください。");
    }

    const snap = snapshot();
    const stopButton = findGeneratingButton();
    if (!stopButton) {
      throw new Error("固着状態が変わりました。現在の画面を再確認してください。");
    }

    stopButton.click();
    const stopped = await waitFor(() => !findGeneratingButton(), 8000, 150);
    if (!stopped) {
      throw new Error("ChatGPTの停止を確認できませんでした。メッセージは送っていません。");
    }

    await nudgeNow();
    return statusPayload();
  }

  async function retryFailedSubmission() {
    if (route.kind !== "conversation") throw new Error("会話ページで実行してください。");
    const snap = snapshot();
    const retryButton = findRetryButton(snap.lastTurn);
    if (!snap.retryableSendFailure || !retryButton || !snap.lastTurnKey) {
      throw new Error("再試行できる送信失敗が見つかりません。現在の画面を再確認してください。");
    }
    if (session.lastRetriedTurnKey === snap.retryTurnKey) {
      throw new Error("同じ送信失敗への自動Retryはすでに1回実行しました。");
    }

    await saveSession({
      status: "retrying",
      lastRetriedTurnKey: snap.retryTurnKey,
      candidateSeenAt: Date.now(),
      detail: "再開依頼の送信失敗を検出しました。Retryで同じメッセージを1回だけ再送します👏🍵"
    });
    retryButton.click();
    const retried = await waitFor(() => {
      const next = snapshot();
      return next.generating || !next.retryableSendFailure;
    }, 5000, 150);
    if (!retried) {
      throw new Error("Retry後の送信開始を確認できませんでした。重複防止のため自動Retryは繰り返しません。");
    }

    await saveSession({
      status: "sent",
      candidateAssistantKey: null,
      candidateSeenAt: 0,
      detail: "送信失敗した労い＋再開依頼をRetryで再送しました👏🍵"
    });
    return statusPayload();
  }

  async function beginRollover(reason = "manual") {
    if (route.kind !== "conversation" || !route.projectSlug || !route.projectBaseUrl) {
      throw new Error("同じプロジェクトへの引き継ぎは、プロジェクト内の会話だけで使えます。");
    }
    const snap = snapshot();
    const pending = {
      version: 1,
      reason,
      stage: "navigate",
      createdAt: Date.now(),
      sourceUrl: location.href,
      projectSlug: route.projectSlug,
      projectBaseUrl: route.projectBaseUrl,
      projectName: config.projectName,
      nudgeCount: session.nudgeCount,
      rolloverCount: session.rolloverCount + 1,
      prompt: core.buildRolloverPrompt({
        config,
        sourceUrl: location.href,
        lastUserText: snap.lastUser?.text,
        lastAssistantText: snap.lastAssistant?.text
      })
    };
    await storageSet({ [PENDING_ROLLOVER_KEY]: pending });
    await saveSession({
      enabled: false,
      status: "rollover",
      detail: "同じ『翻訳』プロジェクトの新しいスレへ引き継ぎます↗"
    });
    location.assign(route.projectBaseUrl);
  }

  function composerMatchesProject(expectedName) {
    const composer = findComposer();
    if (!composer) return false;
    const label = [
      composer.getAttribute("aria-label"),
      composer.getAttribute("placeholder"),
      composer.getAttribute("data-placeholder"),
      elementText(composer)
    ].filter(Boolean).join(" ");
    return label.includes(expectedName) || document.title.includes(expectedName);
  }

  async function resumePendingRollover() {
    const stored = await storageGet(PENDING_ROLLOVER_KEY);
    const pending = stored[PENDING_ROLLOVER_KEY];
    if (!pending) return false;
    if (Date.now() - Number(pending.createdAt || 0) > ROLLOVER_TTL_MS) {
      await storageRemove(PENDING_ROLLOVER_KEY);
      return false;
    }
    if (route.projectSlug !== pending.projectSlug) return false;

    if (route.kind === "project" && pending.stage === "navigate") {
      const composer = await waitFor(findComposer, 10000, 250);
      if (!composer || !composerMatchesProject(pending.projectName)) {
        pending.stage = "blocked";
        pending.error = `『${pending.projectName}』プロジェクトの入力欄を確認できませんでした。自動送信していません。`;
        await storageSet({ [PENDING_ROLLOVER_KEY]: pending });
        updateBadge("error");
        return true;
      }
      pending.stage = "submitting";
      await storageSet({ [PENDING_ROLLOVER_KEY]: pending });
      try {
        await submitPrompt(pending.prompt);
        pending.stage = "submitted";
        pending.submittedAt = Date.now();
        await storageSet({ [PENDING_ROLLOVER_KEY]: pending });
      } catch (error) {
        pending.stage = "blocked";
        pending.error = String(error?.message || error);
        await storageSet({ [PENDING_ROLLOVER_KEY]: pending });
        updateBadge("error");
      }
      return true;
    }

    if (route.kind === "conversation" && pending.stage === "submitted") {
      const key = sessionStorageKey();
      session = {
        ...defaultSession(),
        enabled: true,
        nudgeCount: 0,
        rolloverCount: Number(pending.rolloverCount || 1),
        status: "generating",
        detail: "新しいスレへ引き継ぎ、再開依頼を送りました👏🍵",
        updatedAt: Date.now()
      };
      if (key) await storageSet({ [key]: session });
      await storageRemove(PENDING_ROLLOVER_KEY);
      updateBadge("generating");
      return true;
    }

    return false;
  }

  async function tick() {
    if (!contextAlive || tickRunning) return;
    tickRunning = true;
    try {
      if (location.href !== lastUrl) {
        lastUrl = location.href;
        route = core.parseChatGPTLocation(location.href);
        await loadState();
      }

      if (await resumePendingRollover()) return;
      if (route.kind !== "conversation" || !session?.enabled) return;

      const snap = snapshot();
      const assistantKey = snap.assistantKey;
      const observationKey = snap.observationKey;
      let candidateSeenAt = session.candidateSeenAt || 0;
      if (observationKey && observationKey !== session.candidateAssistantKey) {
        candidateSeenAt = Date.now();
        await saveSession({
          candidateAssistantKey: observationKey,
          candidateSeenAt,
          status: snap.generating ? "generating" : "settling",
          detail: snap.generating
            ? "翻訳中です…"
            : snap.retryableSendFailure
              ? `再開依頼の送信失敗を検出しました。${config.deliveryTimeoutSeconds}秒後にRetryします…`
              : snap.streamCacheFailure
              ? `ストリーム再開エラーを検出しました。${config.deliveryTimeoutSeconds}秒後にRetryします…`
              : snap.thinkingFailed
              ? `Thinking failedを検出しました。${config.deliveryTimeoutSeconds}秒後に続きを頼みます…`
              : snap.analysisFailed
              ? `Analysis erroredを検出しました。${config.silentStallSeconds}秒間、進行を確認します…`
              : snap.silentStalled
              ? `最終回答なしの停止候補です。${config.silentStallSeconds}秒間、変化がないか確認します…`
              : "応答が安定して止まったか確認中です…"
        });
      }

      const decision = core.decideAction({
        enabled: session.enabled,
        capacityLimited: snap.capacityLimited,
        rolloverEnabled: config.rolloverEnabled,
        projectSlug: route.projectSlug,
        completed: snap.completed,
        terminalErrorBlocked: snap.terminalErrorBlocked,
        stopOnTerminalError: config.stopOnTerminalError,
        generating: snap.generating,
        interrupted: snap.interrupted,
        deliveryTimedOut: snap.deliveryTimedOut,
        thinkingFailed: snap.thinkingFailed,
        analysisFailed: snap.analysisFailed,
        retryableSendFailure: snap.retryableSendFailure,
        retryTurnKey: snap.retryTurnKey,
        lastRetriedTurnKey: session.lastRetriedTurnKey,
        streamCacheFailure: snap.streamCacheFailure,
        streamCacheTurnKey: snap.streamCacheTurnKey,
        streamCacheDraftSafe: snap.streamCacheDraftSafe,
        lastRetriedStreamTurnKey: session.lastRetriedStreamTurnKey,
        composerReady: snap.composerReady,
        hasToolActivity: snap.hasToolActivity,
        hasResponseActions: snap.hasResponseActions,
        silentStalled: snap.silentStalled,
        lastRole: snap.lastTurn?.role,
        assistantKey,
        lastHandledAssistantKey: session.lastHandledAssistantKey,
        nudgeCount: session.nudgeCount,
        maxNudges: config.maxNudges,
        stableForMs: candidateSeenAt ? Date.now() - candidateSeenAt : 0,
        settleMs: config.settleSeconds * 1000,
        silentStallMs: config.silentStallSeconds * 1000,
        deliveryTimeoutMs: config.deliveryTimeoutSeconds * 1000
      });

      if (decision.action === "recover_stuck") {
        const stuckContext = decision.reason === "delivery_timeout_stuck_generating"
          ? "配信タイムアウト後"
          : "応答中表示のまま";
        const nextDetail = `${stuckContext}、本文・ツール履歴が${config.silentStallSeconds}秒間変わりません。固着した応答を停止し、労い＋再開依頼を自動送信します👏🍵`;
        await saveSession({
          status: "stuck_timeout",
          detail: nextDetail,
          candidateSeenAt: Date.now()
        });
        await recoverStuckResponse();
        return;
      }
      if (decision.action === "retry_failed_submission") {
        await retryFailedSubmission();
        return;
      }
      if (decision.action === "retry_stream_cache") {
        await retryStreamCacheFailure();
        return;
      }
      if (decision.action === "rollover") {
        await beginRollover("capacity");
        return;
      }
      if (decision.action === "complete") {
        await saveSession({
          enabled: false,
          status: "complete",
          completionThanksSent: false,
          detail: "完了合図を確認しました。最後の労いを送って終了します🍻"
        });
        try {
          await submitPrompt(config.completionPrompt);
          await saveSession({
            completionThanksSent: true,
            detail: "完訳を労うメッセージを送り、監視を終了しました🍻🎉"
          });
        } catch (error) {
          await saveSession({
            status: "error",
            detail: `翻訳完了は確認しましたが、最後の労いは送信確認できませんでした：${String(error?.message || error)}`
          });
        }
        return;
      }
      if (decision.action === "thank_and_stop") {
        await saveSession({
          enabled: false,
          status: "stopped_error",
          terminalErrorThanksSent: false,
          lastHandledAssistantKey: assistantKey,
          detail: "続行不能のエラー報告を確認しました。労いを送って終了します👏🍵"
        });
        try {
          await submitPrompt(config.terminalErrorPrompt);
          await saveSession({
            terminalErrorThanksSent: true,
            detail: "ここまでの作業を労い、監視を終了しました👏🍵"
          });
        } catch (error) {
          await saveSession({
            status: "error",
            detail: `続行不能のエラーは確認しましたが、労いの送信を確認できませんでした：${String(error?.message || error)}`
          });
        }
        return;
      }
      if (decision.action === "pause") {
        await saveSession({
          enabled: false,
          status: "paused",
          detail: decision.reason === "nudge_limit"
            ? `再開依頼が上限 ${config.maxNudges} 回に達したため停止しました。`
            : "容量上限を検知しましたが、安全なプロジェクト内引き継ぎ先を確認できませんでした。"
        });
        return;
      }
      if (decision.action === "nudge") {
        await nudgeNow(snap.assistantKey);
        return;
      }

      if (decision.reason === "retry_already_attempted") {
        const nextDetail = "同じ送信失敗への自動Retryは1回実行済みです。再び失敗したため、画面の確認が必要です。";
        if (session.status !== "error" || session.detail !== nextDetail) {
          await saveSession({ status: "error", detail: nextDetail });
        }
        return;
      }

      if (decision.reason === "stream_cache_retry_already_attempted") {
        const nextDetail = "同じストリーム再開エラーへのRetryは1回試みました。重複操作せず画面の確認を待っています。";
        if (session.status !== "error" || session.detail !== nextDetail) {
          await saveSession({ status: "error", detail: nextDetail });
        }
        return;
      }
      if (decision.reason === "draft_protected") {
        const nextDetail = "下書きを保護しています。ストリーム再開エラーのRetryは押していません。";
        if (session.status !== "waiting" || session.detail !== nextDetail) {
          await saveSession({ status: "waiting", detail: nextDetail });
        }
        return;
      }

      if (snap.generating) {
        const nextStatus = snap.interrupted ? "interrupted" : "generating";
        const nextDetail = snap.interrupted
          ? "接続中断表示です。ChatGPTが応答中扱いのため、安全のため停止ボタンは押さず待っています。"
          : "翻訳中です…";
        if (session.status !== nextStatus || session.detail !== nextDetail) {
          await saveSession({ status: nextStatus, detail: nextDetail });
        }
      }
    } catch (error) {
      if (stopIfContextInvalidated(error)) return;
      try {
        await saveSession({
          status: "error",
          detail: String(error?.message || error)
        });
      } catch (reportError) {
        if (!stopIfContextInvalidated(reportError)) {
          console.warn("[翻訳おつかれ Watchdog] エラー状態を保存できませんでした", reportError);
        }
      }
    } finally {
      tickRunning = false;
    }
  }

  function scheduleTick() {
    if (!contextAlive) return;
    if (tickTimer) clearInterval(tickTimer);
    tickTimer = setInterval(() => {
      void tick().catch(error => {
        if (!stopIfContextInvalidated(error)) {
          console.warn("[翻訳おつかれ Watchdog] 監視処理に失敗しました", error);
        }
      });
    }, config.monitorIntervalSeconds * 1000);
  }

  function statusPayload() {
    const snap = route.kind === "conversation" ? snapshot() : null;
    return {
      ok: true,
      route,
      config,
      session,
      snapshot: snap ? {
        generating: snap.generating,
        interrupted: snap.interrupted,
        deliveryTimedOut: snap.deliveryTimedOut,
        retryableSendFailure: snap.retryableSendFailure,
        streamCacheFailure: snap.streamCacheFailure,
        silentStalled: snap.silentStalled,
        hasToolActivity: snap.hasToolActivity,
        hasResponseActions: snap.hasResponseActions,
        capacityLimited: snap.capacityLimited,
        completed: snap.completed,
        terminalErrorBlocked: snap.terminalErrorBlocked,
        lastRole: snap.lastTurn?.role || null
      } : null
    };
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    const run = async () => {
      switch (message?.type) {
        case "GET_STATUS":
          await loadState();
          return statusPayload();
        case "SAVE_CONFIG":
          await saveConfig(message.config);
          return statusPayload();
        case "ENABLE":
          if (message.config) await saveConfig(message.config);
          return enableMonitor();
        case "DISABLE":
          return disableMonitor();
        case "NUDGE_NOW":
          if (message.config) await saveConfig(message.config);
          return nudgeNow();
        case "RECOVER_STUCK_TIMEOUT":
          if (message.config) await saveConfig(message.config);
          return recoverStuckResponse();
        case "ROLLOVER_NOW":
          if (message.config) await saveConfig(message.config);
          await beginRollover("manual");
          return { ok: true };
        case "RESET_COUNT":
          await saveSession({ nudgeCount: 0, detail: "再開回数を0に戻しました。" });
          return statusPayload();
        default:
          return { ok: false, error: "unknown_message" };
      }
    };

    run()
      .then(sendResponse)
      .catch(error => {
        if (stopIfContextInvalidated(error)) return;
        try {
          sendResponse({ ok: false, error: String(error?.message || error) });
        } catch (responseError) {
          stopIfContextInvalidated(responseError);
        }
      });
    return true;
  });

  (async () => {
    await loadState();
    updateBadge(session.status);
    scheduleTick();
    await tick();
  })().catch(error => {
    if (stopIfContextInvalidated(error)) return;
    console.warn("[翻訳おつかれ Watchdog] 初期化に失敗しました", error);
    updateBadge("error");
  });
})();
