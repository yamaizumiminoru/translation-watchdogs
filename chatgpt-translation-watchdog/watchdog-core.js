(function attachWatchdogCore(root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.ChatGPTTranslationWatchdogCore = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function createWatchdogCore() {
  "use strict";

  const DEFAULT_REPOSITORY_URL = "https://github.com/yamaizumiminoru/translations";
  const DEFAULT_PROMPT =
    "ここまで本当にありがとう、おつかれさまです👏🍵　保存済みの続きからお願いします🙏\n" +
    "ChatGPTプロジェクト内の原典PDFをページ画像で確認し、https://github.com/yamaizumiminoru/translations の main にある該当 projects/<slug>/ の manifest・checkpoint・chunk inventory・QA・manuscript を再取得してください。output は直接編集せず、未完了箇所から作業を続けてください。翻訳がすべて完了したときだけ、回答末尾に [[TRANSLATION_COMPLETE]] と付けてください。";
  const DEFAULT_COMPLETION_PROMPT =
    "完訳おつかれさまでした！最後まで本当にありがとう🍻🎉　保存と最終確認もありがとう。ここで終了です☺️";
  const DEFAULT_TERMINAL_ERROR_PROMPT =
    "ここまで進めてくれて本当にありがとう、おつかれさまでした👏🍵　エラーでこれ以上続けられない件、了解です。保存済みの状態はそのままにして、ここで止めます🙏";

  const DEFAULTS = Object.freeze({
    prompt: DEFAULT_PROMPT,
    completionPrompt: DEFAULT_COMPLETION_PROMPT,
    terminalErrorPrompt: DEFAULT_TERMINAL_ERROR_PROMPT,
    completionMarker: "[[TRANSLATION_COMPLETE]]",
    projectName: "翻訳",
    repositoryUrl: DEFAULT_REPOSITORY_URL,
    maxNudges: 20,
    settleSeconds: 20,
    silentStallSeconds: 180,
    deliveryTimeoutSeconds: 5,
    rolloverEnabled: true,
    stopOnTerminalError: true,
    monitorIntervalSeconds: 3
  });

  const CAPACITY_PATTERNS = [
    /maximum\s+(?:conversation\s+)?length/i,
    /reached\s+(?:the\s+)?(?:maximum|message|conversation).*limit/i,
    /conversation\s+(?:is\s+)?too\s+long/i,
    /start\s+(?:a\s+)?new\s+(?:chat|conversation).*continue/i,
    /(?:この|現在の)(?:会話|チャット|スレッド).{0,30}(?:最大長|容量|上限).{0,20}(?:達|超)/,
    /(?:会話|チャット|スレッド).{0,20}(?:長すぎ|これ以上続けられ)/,
    /新しい(?:会話|チャット|スレッド).{0,20}(?:開始|続け)/
  ];

  const TRANSIENT_PATTERNS = [
    /connection interrupted/i,
    /waiting for the complete answer/i,
    /network error/i,
    /message delivery timed out/i,
    /接続が中断/,
    /完全な回答を待って/,
    /ネットワークエラー/,
    /メッセージ.{0,20}タイムアウト/
  ];

  const DELIVERY_TIMEOUT_PATTERNS = [
    /message delivery timed out\.?(?:\s+please try again\.?)?/i,
    /メッセージ(?:の)?(?:配信|送信).{0,20}タイムアウト/
  ];

  const RETRYABLE_SEND_FAILURE_PATTERNS = [
    /something went wrong\.?(?:\s+please try again\.?)?/i,
    /there was an error generating a response/i,
    /(?:問題|エラー)が発生しました.{0,30}(?:もう一度|再試行|お試し)/s
  ];

  const TERMINAL_ERROR_PATTERNS = [
    /(?:cannot|can't|unable to)\s+(?:continue|proceed).{0,100}(?:error|failure|blocked|unavailable)/is,
    /(?:error|failure|blocked|unavailable).{0,100}(?:cannot|can't|unable to)\s+(?:continue|proceed)/is,
    /(?:エラー|障害|不具合|失敗).{0,60}(?:続けられません|続けられない|続行できません|続行できない|継続できません|継続できない|作業できません|作業できない)/s,
    /(?:続けられません|続けられない|続行できません|続行できない|継続できません|継続できない).{0,60}(?:エラー|障害|不具合|失敗)/s
  ];

  function clampInteger(value, fallback, min, max) {
    const parsed = Number.parseInt(String(value), 10);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(max, Math.max(min, parsed));
  }

  function normalizeConfig(input) {
    const value = input && typeof input === "object" ? input : {};
    const prompt = String(value.prompt || DEFAULTS.prompt).trim();
    const completionPrompt = String(value.completionPrompt || DEFAULTS.completionPrompt).trim();
    const terminalErrorPrompt = String(value.terminalErrorPrompt || DEFAULTS.terminalErrorPrompt).trim();
    const completionMarker = String(value.completionMarker || DEFAULTS.completionMarker).trim();
    const projectName = String(value.projectName || DEFAULTS.projectName).trim();
    const repositoryUrl = String(value.repositoryUrl || DEFAULTS.repositoryUrl).trim();
    return {
      prompt: prompt || DEFAULTS.prompt,
      completionPrompt: completionPrompt || DEFAULTS.completionPrompt,
      terminalErrorPrompt: terminalErrorPrompt || DEFAULTS.terminalErrorPrompt,
      completionMarker: completionMarker || DEFAULTS.completionMarker,
      projectName: projectName || DEFAULTS.projectName,
      repositoryUrl: repositoryUrl || DEFAULTS.repositoryUrl,
      maxNudges: clampInteger(value.maxNudges, DEFAULTS.maxNudges, 1, 100),
      settleSeconds: clampInteger(value.settleSeconds, DEFAULTS.settleSeconds, 5, 300),
      silentStallSeconds: clampInteger(
        value.silentStallSeconds,
        DEFAULTS.silentStallSeconds,
        30,
        600
      ),
      deliveryTimeoutSeconds: clampInteger(
        value.deliveryTimeoutSeconds,
        DEFAULTS.deliveryTimeoutSeconds,
        2,
        60
      ),
      rolloverEnabled: value.rolloverEnabled !== false,
      stopOnTerminalError: value.stopOnTerminalError !== false,
      monitorIntervalSeconds: clampInteger(
        value.monitorIntervalSeconds,
        DEFAULTS.monitorIntervalSeconds,
        2,
        30
      )
    };
  }

  function parseChatGPTLocation(url) {
    try {
      const parsed = new URL(url);
      if (parsed.hostname !== "chatgpt.com") return { kind: "unsupported" };

      const projectConversation = parsed.pathname.match(
        /^\/g\/(g-p-[^/]+)\/c\/([0-9a-f-]+)(?:\/|$)/i
      );
      if (projectConversation) {
        return {
          kind: "conversation",
          conversationId: projectConversation[2],
          projectSlug: projectConversation[1],
          projectBaseUrl: `${parsed.origin}/g/${projectConversation[1]}/project`,
          sessionKey: `project:${projectConversation[1]}:${projectConversation[2]}`
        };
      }

      const projectHome = parsed.pathname.match(/^\/g\/(g-p-[^/]+)\/project(?:\/|$)/i);
      if (projectHome) {
        return {
          kind: "project",
          projectSlug: projectHome[1],
          projectBaseUrl: `${parsed.origin}/g/${projectHome[1]}/project`,
          sessionKey: `project:${projectHome[1]}`
        };
      }

      const conversation = parsed.pathname.match(/^\/c\/([0-9a-f-]+)(?:\/|$)/i);
      if (conversation) {
        return {
          kind: "conversation",
          conversationId: conversation[1],
          projectSlug: null,
          projectBaseUrl: null,
          sessionKey: `chat:${conversation[1]}`
        };
      }

      return { kind: "other" };
    } catch (_error) {
      return { kind: "unsupported" };
    }
  }

  function fnv1a(text) {
    let hash = 0x811c9dc5;
    const source = String(text || "");
    for (let index = 0; index < source.length; index += 1) {
      hash ^= source.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(16).padStart(8, "0");
  }

  // ChatGPT updates elapsed-time labels while a tool is running. A changing
  // clock is not new output and must not restart the inactivity timer.
  function progressText(text) {
    return String(text || "").replace(
      /(^|\n)(\s*Worked for\s+)\d+(?:h\s*)?\d*(?:m\s*)?\d*s\b/gi,
      "$1$2<elapsed>"
    );
  }

  function hasUnfinishedToolError(text) {
    return /Encountered exception:\s*<class\s+['"][^'">]*\bClientError['"]>\.?\s*$/i
      .test(String(text || "").trim());
  }

  function makeTurnKey(turn) {
    if (!turn) return null;
    const id = String(turn.id || "unknown");
    const text = String(turn.text || "");
    return `${id}:${fnv1a(text)}`;
  }

  // Recovery is once per assistant turn, even while that turn's text grows.
  // makeTurnKey remains content-sensitive for the inactivity timer.
  function makeStableTurnKey(turn) {
    return turn ? String(turn.id || "unknown") : null;
  }

  function normalizeTurnRole(...values) {
    for (const value of values) {
      const role = String(value || "").trim().toLowerCase();
      if (role === "assistant" || role === "user") return role;
    }
    return null;
  }

  function inferTurnRole(input) {
    const value = input && typeof input === "object" ? input : {};
    const explicit = normalizeTurnRole(value.dataTurn, value.authorRole);
    if (explicit) return explicit;
    if (value.hasUserBubble) return "user";
    const searchKey = String(value.searchUnitKey || "");
    const match = searchKey.match(/:(user|assistant)$/i);
    return match ? match[1].toLowerCase() : null;
  }

  function hasCompletionMarker(text, marker) {
    const source = String(text || "");
    const token = String(marker || "").trim();
    return token.length > 0 && source.includes(token);
  }

  function hasCapacityLimit(text) {
    const source = String(text || "");
    return CAPACITY_PATTERNS.some(pattern => pattern.test(source));
  }

  function hasTransientInterruption(text) {
    const source = String(text || "");
    return TRANSIENT_PATTERNS.some(pattern => pattern.test(source));
  }

  function hasDeliveryTimeout(text) {
    const source = String(text || "");
    return DELIVERY_TIMEOUT_PATTERNS.some(pattern => pattern.test(source));
  }

  function hasThinkingFailureLabel(text) {
    return /^Thinking failed\.?$/i.test(String(text || "").trim());
  }

  function hasStreamCacheExpiredLabel(text) {
    // Keep the existing API name; both labels use the same bounded UI Retry.
    return /^(?:Stream cache expired|Resume stream unavailable)\.?$/i.test(String(text || "").trim());
  }

  function hasAnalysisErrorLabel(text) {
    return /^Analysis errored\.?$/i.test(String(text || "").trim());
  }

  function hasRetryableSendFailure(text) {
    const source = String(text || "");
    return RETRYABLE_SEND_FAILURE_PATTERNS.some(pattern => pattern.test(source));
  }

  function hasTerminalErrorBlocker(text) {
    const source = String(text || "");
    if (hasCapacityLimit(source)) return false;
    return TERMINAL_ERROR_PATTERNS.some(pattern => pattern.test(source));
  }

  function isExtensionContextInvalidated(error) {
    const message = String(error?.message || error || "");
    return /extension context invalidated/i.test(message);
  }

  function isSilentStallCandidate(input) {
    const state = input && typeof input === "object" ? input : {};
    return state.lastRole === "assistant" &&
      state.generating === false &&
      state.deliveryTimedOut !== true &&
      state.composerReady === true &&
      state.hasResponseActions === false &&
      (state.hasToolActivity === true || state.analysisFailed === true || state.unfinishedToolError === true);
  }

  function decideAction(input) {
    const state = input && typeof input === "object" ? input : {};
    if (!state.enabled) return { action: "disabled", reason: "monitor_off" };
    if (state.streamCacheFailure) {
      if (state.streamCacheTurnKey && state.streamCacheTurnKey === state.lastRetriedStreamTurnKey) {
        return { action: "wait", reason: "stream_cache_retry_already_attempted" };
      }
      if (!state.streamCacheDraftSafe) return { action: "wait", reason: "draft_protected" };
      if (state.nudgeCount >= state.maxNudges) return { action: "pause", reason: "nudge_limit" };
      const retryDelayMs = Number.isFinite(state.deliveryTimeoutMs)
        ? state.deliveryTimeoutMs
        : DEFAULTS.deliveryTimeoutSeconds * 1000;
      if (state.stableForMs < retryDelayMs) return { action: "wait", reason: "settling" };
      return { action: "retry_stream_cache", reason: "stream_cache_expired" };
    }
    // A visible Retry error on the latest user turn is authoritative. ChatGPT
    // occasionally leaves a stop-like control visible after the send failed.
    if (state.retryableSendFailure) {
      if (state.retryTurnKey && state.retryTurnKey === state.lastRetriedTurnKey) {
        return { action: "wait", reason: "retry_already_attempted" };
      }
      const retryDelayMs = Number.isFinite(state.deliveryTimeoutMs)
        ? state.deliveryTimeoutMs
        : DEFAULTS.deliveryTimeoutSeconds * 1000;
      if (state.stableForMs < retryDelayMs) {
        return { action: "wait", reason: "settling" };
      }
      return { action: "retry_failed_submission", reason: "retryable_send_failure" };
    }
    if (state.generating) {
      const stableForMs = Number.isFinite(state.stableForMs) ? state.stableForMs : 0;
      const stuckTimeoutMs = Number.isFinite(state.silentStallMs)
        ? state.silentStallMs
        : DEFAULTS.silentStallSeconds * 1000;
      const frozenToolResponse = state.lastRole === "assistant" &&
        (state.hasToolActivity === true || state.unfinishedToolError === true) &&
        state.composerReady === true;
      if (stableForMs >= stuckTimeoutMs && (state.deliveryTimedOut || frozenToolResponse)) {
        if (state.nudgeCount >= state.maxNudges) {
          return { action: "pause", reason: "nudge_limit" };
        }
        return {
          action: "recover_stuck",
          reason: state.deliveryTimedOut
            ? "delivery_timeout_stuck_generating"
            : "generation_stuck_no_change"
        };
      }
      return {
        action: "wait",
        reason: state.interrupted ? "connection_interrupted_but_still_generating" : "generating"
      };
    }
    if (state.capacityLimited) {
      return state.rolloverEnabled && state.projectSlug
        ? { action: "rollover", reason: "conversation_capacity" }
        : { action: "pause", reason: "capacity_without_safe_rollover" };
    }
    if (state.completed) return { action: "complete", reason: "completion_marker" };
    if (state.lastRole !== "assistant") return { action: "wait", reason: "awaiting_assistant" };
    if (!state.assistantKey) return { action: "wait", reason: "no_assistant_turn" };
    if (state.assistantKey === state.lastHandledAssistantKey) {
      return { action: "wait", reason: "assistant_turn_already_handled" };
    }
    const requiredSettleMs = state.deliveryTimedOut || state.thinkingFailed
      ? state.deliveryTimeoutMs
      : state.silentStalled
        ? state.silentStallMs
        : state.settleMs;
    if (state.stableForMs < requiredSettleMs) return { action: "wait", reason: "settling" };
    if (state.terminalErrorBlocked && state.stopOnTerminalError) {
      return { action: "thank_and_stop", reason: "terminal_error_blocker" };
    }
    if (state.nudgeCount >= state.maxNudges) {
      return { action: "pause", reason: "nudge_limit" };
    }
    return {
      action: "nudge",
      reason: state.thinkingFailed
        ? "thinking_failed"
        : state.deliveryTimedOut
        ? "delivery_timeout"
        : state.silentStalled
          ? "silent_stall"
          : "assistant_stopped"
    };
  }

  function tail(text, limit) {
    const source = String(text || "").trim();
    if (source.length <= limit) return source;
    return `…${source.slice(-limit)}`;
  }

  function buildRolloverPrompt(input) {
    const value = input && typeof input === "object" ? input : {};
    const config = normalizeConfig(value.config);
    const sourceUrl = String(value.sourceUrl || "").trim();
    const userTail = tail(value.lastUserText, 2500);
    const assistantTail = tail(value.lastAssistantText, 6000);
    const parts = [
      "前スレが容量上限に達したため、同じ『" + config.projectName + "』プロジェクト内での続きです。おつかれさまです👏🍵",
      "永続状態のリポジトリは " + config.repositoryUrl + " です。main の該当 projects/<slug>/ にある manifest・checkpoint・chunk inventory・QA・manuscript をあらためて取得し、記録された Next starting point から翻訳を再開してください。output は生成物なので直接編集しないでください。",
      "原典の権威はこのChatGPTプロジェクトにアップロードされたPDFです。構造が不確かな箇所はOCRだけで確定せず、ページ画像を確認してください。前スレの記憶だけで進捗や本文を推測しないでください。",
      "再開後は、作業を可能なところまで進めて保存してください。翻訳がすべて完了したときだけ、回答末尾に " + config.completionMarker + " と付けてください。"
    ];
    if (sourceUrl) parts.push(`引き継ぎ元スレ: ${sourceUrl}`);
    if (userTail) parts.push(`前スレ末尾のユーザーメッセージ抜粋:\n---\n${userTail}\n---`);
    if (assistantTail) parts.push(`前スレ末尾の応答抜粋:\n---\n${assistantTail}\n---`);
    parts.push("それでは、保存済みの続きからお願いします🙏");
    return parts.join("\n\n");
  }

  return {
    DEFAULTS,
    DEFAULT_PROMPT,
    DEFAULT_COMPLETION_PROMPT,
    DEFAULT_TERMINAL_ERROR_PROMPT,
    DEFAULT_REPOSITORY_URL,
    normalizeConfig,
    parseChatGPTLocation,
    fnv1a,
    progressText,
    hasUnfinishedToolError,
    makeTurnKey,
    makeStableTurnKey,
    normalizeTurnRole,
    inferTurnRole,
    hasCompletionMarker,
    hasCapacityLimit,
    hasTransientInterruption,
    hasDeliveryTimeout,
    hasThinkingFailureLabel,
    hasStreamCacheExpiredLabel,
    hasAnalysisErrorLabel,
    hasRetryableSendFailure,
    hasTerminalErrorBlocker,
    isExtensionContextInvalidated,
    isSilentStallCandidate,
    decideAction,
    buildRolloverPrompt
  };
});
