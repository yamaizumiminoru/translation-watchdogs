(function (root, factory) {
  const core = typeof module !== "undefined" && module.exports ? require("./watchdog-core.js") : root.ChatGPTErrorWatchdogCore;
  const api = factory(core);
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.ChatGPTErrorWatchdogDOM = api;
})(globalThis, function (core) {
  "use strict";
  const TURN = '[data-testid^="conversation-turn-"], [data-turn-key]';
  const BODY = '.markdown, .whitespace-pre-wrap, [data-user-message-bubble], pre, code, blockquote, [contenteditable="true"]';
  const text = el => String(el?.innerText ?? el?.textContent ?? "").trim();
  function visible(el) {
    if (!el || el.closest('[hidden], [aria-hidden="true"], [inert]')) return false;
    for (let ancestor = el; ancestor; ancestor = ancestor.parentElement) {
      const style = el.ownerDocument.defaultView.getComputedStyle(ancestor);
      if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse") return false;
    }
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }
  const enabled = el => visible(el) && !el.disabled && el.getAttribute("aria-disabled") !== "true";
  function collect(doc) {
    let nodes = [...doc.querySelectorAll(TURN)];
    nodes = nodes.filter(node => !node.parentElement?.closest(TURN));
    if (!nodes.length) {
      nodes = [...doc.querySelectorAll('[data-message-author-role="user"], [data-message-author-role="assistant"]')];
    }
    const entries = nodes.flatMap(node => {
      const units = [...node.querySelectorAll('[data-chatgpt-search-unit-key]')]
        .filter(unit => /:(user|assistant)$/i.test(unit.getAttribute('data-chatgpt-search-unit-key') || ''));
      if (units.length < 2) return [{ node }];
      // Current ChatGPT can group a user message and its reply in one turn-key.
      return units.map(unit => ({
        node: unit.parentElement !== node && node.contains(unit.parentElement) &&
          unit.parentElement.querySelectorAll('[data-chatgpt-search-unit-key]').length === 1
          ? unit.parentElement : unit,
        id: `${node.getAttribute('data-turn-key') || node.getAttribute('data-testid')}:${unit.getAttribute('data-chatgpt-search-unit-key')}`
      }));
    });
    return entries.map(({ node, id: boundaryId }, index) => {
      const message = node.matches("[data-message-author-role]") ? node : node.querySelector("[data-message-author-role]");
      const explicitRole = [node.getAttribute("data-turn"), message?.getAttribute("data-message-author-role")]
        .find(value => value === "user" || value === "assistant");
      const searchRole = (node.matches('[data-chatgpt-search-unit-key]') ? node : node.querySelector("[data-chatgpt-search-unit-key]"))
        ?.getAttribute("data-chatgpt-search-unit-key")?.match(/:(user|assistant)$/i)?.[1]?.toLowerCase();
      const role = explicitRole || (node.querySelector("[data-user-message-bubble]") ? "user" : searchRole);
      const body = message?.querySelector(".markdown, .whitespace-pre-wrap") ||
        node.querySelector(".markdown, .whitespace-pre-wrap, [data-user-message-bubble]") || message || node;
      const id = boundaryId || node.getAttribute("data-message-id") || node.querySelector("[data-message-id]")?.getAttribute("data-message-id") ||
        node.getAttribute("data-turn-key") || node.getAttribute("data-testid") || `${role}:${index}:${core.hash(text(body))}`;
      return { node, body, role, id };
    }).filter(turn => turn.role === "user" || turn.role === "assistant");
  }
  function retryButton(turn) {
    return [...(turn?.node.querySelectorAll("button") || [])].find(button => {
      if (!visible(button) || button.closest(BODY)) return false;
      const labels = [button.getAttribute("aria-label"), text(button)].filter(Boolean);
      return labels.some(label => /^(?:Retry|Try again|再試行|もう一度試す)$/i.test(label.trim()));
    }) || null;
  }
  function streamRetryButton(label, turn) {
    // Pair an exact stream label only with Retry in its nearby error row.
    // Never walk across the turn boundary or through rendered message prose.
    let row = label;
    for (let depth = 0; row && row !== turn.node && depth < 3; depth++, row = row.parentElement) {
      if (row.closest(BODY) || row.querySelector(BODY)) break;
      const retry = [...row.querySelectorAll("button")].find(button =>
        visible(button) && !button.closest(BODY) &&
        [button.getAttribute("aria-label"), text(button)].some(value =>
          /^(?:Retry|Try again|再試行|もう一度試す)$/i.test(String(value || "").trim())));
      if (retry) return retry;
    }
    return null;
  }
  function errorFor(turn) {
    if (!turn) return null;
    // Only error UI in the most recent turn. Do not read body prose as errors.
    const candidates = [...turn.node.querySelectorAll('[role="alert"], [data-testid*="error" i], [data-error-code], div, span, p, button')];
    const nativeRetry = turn.node.querySelector('button[data-testid="regenerate-thread-error-button"]');
    const hasResponseActions = Boolean(turn.node.querySelector('[aria-label="Response actions"], [data-testid="copy-turn-action-button"], button[aria-label="Copy response"]'));
    let recoverable = null;
    for (const node of candidates) {
      if (!visible(node) || node.closest(BODY)) continue;
      // A container that also includes rendered user/assistant prose is not an error label.
      if (node.querySelector(BODY)) continue;
      const value = core.compact(text(node));
      if (!value || value.length > 700) continue;
      const withoutRetry = value.replace(/\s+(?:Retry|Try again|再試行|もう一度試す)$/i, "");
      const kind = core.classify(withoutRetry);
      if (!kind) continue;
      const streamRetry = kind === "stream" && turn.role === "assistant"
        ? streamRetryButton(node, turn) : null;
      if (kind === "stream" && !streamRetry) continue;
      // ChatGPT's failed-user-send label is unmarked, but sits beside its native Retry.
      // Keep quoted error text inside the message body excluded.
      const bodyLeaf = node.closest('[data-message-author-role]');
      const nativeErrorLabel = nativeRetry && node.parentElement === nativeRetry.parentElement &&
        !node.contains(nativeRetry);
      const thinkingFailure = kind === "thinking" && turn.role === "assistant" &&
        node.matches("button") && !hasResponseActions;
      if (kind === "thinking" && !thinkingFailure) continue;
      const explicit = node.closest('[role="alert"], [data-testid*="error" i], [data-error-code]') ||
        nativeErrorLabel || thinkingFailure || streamRetry;
      if (bodyLeaf && !explicit) continue;
      if (turn.body === turn.node && !explicit) continue;
      if (kind === "blocked") return { kind, node, text: withoutRetry };
      recoverable = { kind, node, text: withoutRetry, retry: streamRetry };
    }
    return recoverable;
  }
  function composer(doc) {
    return [...doc.querySelectorAll('#prompt-textarea, textarea[placeholder], [contenteditable="true"][data-virtualkeyboard]')].find(enabled) || null;
  }
  function composerText(el) { return el && "value" in el ? el.value : text(el); }
  function stop(doc) {
    return [...doc.querySelectorAll('button[data-testid="stop-button"], #composer-submit-button[aria-label*="Stop" i], button[aria-label*="Stop answering" i], button[aria-label*="Stop generating" i], button[aria-label*="回答を停止"], button[aria-label*="生成を停止"]')].find(enabled) || null;
  }
  function send(doc) {
    const stopping = stop(doc);
    return [...doc.querySelectorAll('button[data-testid="send-button"], #composer-submit-button, button[aria-label="Send prompt"], button[aria-label="Send message"], button[aria-label="Send"], button[aria-label="送信"]')]
      .find(button => button !== stopping && enabled(button)) || null;
  }
  function attachments(el) {
    if (!el) return false;
    const scope = el.closest('form, [data-testid="composer"], #thread-bottom-container, [data-testid="thread-bottom-container"]') || el.parentElement?.parentElement;
    if (!scope) return false;
    return [...scope.querySelectorAll('input[type="file"]')].some(input => input.files?.length) ||
      [...scope.querySelectorAll('[data-testid*="attachment" i], [data-testid*="file-preview" i], [data-testid*="file-upload" i], button[aria-label*="Remove" i], button[aria-label*="添付を削除"], button[aria-label*="ファイルを削除"]')].some(visible);
  }
  function snapshot(doc) {
    const turns = collect(doc);
    const last = turns.at(-1) || null;
    const error = errorFor(last);
    const input = composer(doc);
    const retry = error?.kind === "stream" ? error.retry : retryButton(last);
    return {
      last, error, input, retry, lastRole: last?.role,
      errorKey: error ? `${error.node.closest('[data-message-id]')?.getAttribute('data-message-id') || last.id}:error` : null,
      // Real visible text changes restart the grace period; animation styles do not.
      progress: last ? core.hash(text(last.node)) : "",
      generating: Boolean(stop(doc)),
      composerReady: Boolean(input), draft: Boolean(composerText(input).trim()),
      attachments: attachments(input), retryReady: Boolean(retry && enabled(retry)),
      turnCount: turns.length,
      userCount: turns.filter(turn => turn.role === "user").length
    };
  }
  return { text, visible, enabled, collect, retryButton, errorFor, composer, composerText, stop, send, attachments, snapshot };
});
