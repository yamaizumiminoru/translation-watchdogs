const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const core = require("../watchdog-core.js");

test("default encouragement includes the requested friendly emoji", () => {
  assert.match(core.DEFAULT_PROMPT, /👏/);
  assert.match(core.DEFAULT_PROMPT, /🍵/);
  assert.match(core.DEFAULT_PROMPT, /🙏/);
});

test("completion thanks uses a celebratory toast and ends the run", () => {
  assert.match(core.DEFAULT_COMPLETION_PROMPT, /🍻/);
  assert.match(core.DEFAULT_COMPLETION_PROMPT, /終了/);
});

test("terminal error thanks is appreciative and explicitly stops", () => {
  assert.match(core.DEFAULT_TERMINAL_ERROR_PROMPT, /👏/);
  assert.match(core.DEFAULT_TERMINAL_ERROR_PROMPT, /🍵/);
  assert.match(core.DEFAULT_TERMINAL_ERROR_PROMPT, /ここで止めます/);
});

test("default repository is the requested durable translation workspace", () => {
  assert.equal(core.DEFAULT_REPOSITORY_URL, "https://github.com/yamaizumiminoru/translations");
  assert.match(core.DEFAULT_PROMPT, /yamaizumiminoru\/translations/);
  assert.match(core.DEFAULT_PROMPT, /projects\/<slug>/);
  assert.match(core.DEFAULT_PROMPT, /output は直接編集せず/);
});

test("parses the real project conversation URL shape", () => {
  const route = core.parseChatGPTLocation(
    "https://chatgpt.com/g/g-p-6aad42ba17dc8191863dc60cda8e53ef-fan-yi/c/6aae350a-e0f4-83ee-80a3-65f7aa7e6118"
  );
  assert.equal(route.kind, "conversation");
  assert.equal(route.projectSlug, "g-p-6aad42ba17dc8191863dc60cda8e53ef-fan-yi");
  assert.equal(route.conversationId, "6aae350a-e0f4-83ee-80a3-65f7aa7e6118");
  assert.equal(
    route.projectBaseUrl,
    "https://chatgpt.com/g/g-p-6aad42ba17dc8191863dc60cda8e53ef-fan-yi/project"
  );
});

test("recognizes both current data-turn roles and the older author-role marker", () => {
  assert.equal(core.normalizeTurnRole("assistant", null), "assistant");
  assert.equal(core.normalizeTurnRole(null, "user"), "user");
  assert.equal(core.normalizeTurnRole("tool", "assistant"), "assistant");
  assert.equal(core.normalizeTurnRole("system", "tool"), null);
});

test("recognizes the current ChatGPT turn-key user bubble and search-unit role", () => {
  assert.equal(core.inferTurnRole({ hasUserBubble: true }), "user");
  assert.equal(core.inferTurnRole({ searchUnitKey: "fallback-turn-9:0:user" }), "user");
  assert.equal(core.inferTurnRole({ searchUnitKey: "fallback-turn-8:0:assistant" }), "assistant");
  assert.equal(core.inferTurnRole({ searchUnitKey: "fallback-turn-8:0:tool" }), null);
  const source = fs.readFileSync(path.join(__dirname, "..", "content.js"), "utf8");
  assert.match(source, /\[data-turn-key\]/);
  assert.match(source, /node\.getAttribute\("data-turn-key"\)/);
  assert.match(source, /hasUserBubble: Boolean\(node\.querySelector\("\[data-user-message-bubble\]"\)\)/);
  assert.match(source, /const beforeIds = new Set\(collectTurns\(\)/);
});

test("finds the current project composer submit button labeled Send", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "content.js"), "utf8");
  const start = source.indexOf("  function findSendButton() {");
  const end = source.indexOf("  function findRetryButton(", start);
  assert.ok(start >= 0 && end > start);

  const sendButton = { disabled: false };
  const context = {
    document: {
      querySelectorAll(selector) {
        return selector === 'button[type="submit"][aria-label="Send"]' ? [sendButton] : [];
      }
    },
    findGeneratingButton: () => null,
    visible: () => true
  };
  const found = vm.runInNewContext(`${source.slice(start, end)}\nfindSendButton()`, context);
  assert.equal(found, sendButton);

  sendButton.disabled = true;
  assert.equal(vm.runInNewContext(`${source.slice(start, end)}\nfindSendButton()`, context), null);
});

test("collects separate stable user and assistant identities inside one shared turn-key", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "content.js"), "utf8");
  const start = source.indexOf("  function collectTurns() {");
  const end = source.indexOf("  function findGeneratingButton()", start);
  const makeUnit = (role, position) => {
    const unit = { getAttribute: name => name === 'data-chatgpt-search-unit-key' ? `fallback-turn-0:${position}:${role}` : null };
    const wrapper = {
      parentElement: null, innerText: role, matches: () => false,
      getAttribute: () => null,
      querySelectorAll: () => [unit],
      querySelector: selector => selector === '[data-chatgpt-search-unit-key]' ? unit : null,
      contains: node => node === unit
    };
    unit.parentElement = wrapper;
    return unit;
  };
  const user = makeUnit('user', 0), assistant = makeUnit('assistant', 2);
  const outer = { getAttribute: name => name === 'data-turn-key' ? 'shared' : null,
    querySelectorAll: () => [user, assistant], contains: node => node !== outer };
  const context = { core, elementText: node => node.innerText,
    document: { querySelectorAll: () => [outer] } };
  const collect = () => vm.runInNewContext(`${source.slice(start, end)}\ncollectTurns()`, context);
  const turns = collect();
  assert.equal(turns.length, 2);
  assert.equal(turns[0].role, 'user');
  assert.equal(turns[1].role, 'assistant');
  assert.equal(turns[1].node, assistant.parentElement);
  assert.notEqual(turns[0].id, turns[1].id);
  assistant.parentElement.innerText += ' updated';
  assert.equal(collect()[1].id, turns[1].id);
});

test("failed-send Retry is keyed to a stable turn ID rather than changing error text", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "content.js"), "utf8");
  assert.match(source, /retryTurnKey: core\.makeStableTurnKey\(lastTurn\)/);
  assert.match(source, /lastRetriedTurnKey: snap\.retryTurnKey/);
  assert.match(source, /retryTurnKey: snap\.retryTurnKey/);
});

test("detects capacity limits in English and Japanese", () => {
  assert.equal(core.hasCapacityLimit("You've reached the maximum length for this conversation."), true);
  assert.equal(core.hasCapacityLimit("この会話は容量の上限に達しました。新しいチャットで続けてください。"), true);
  assert.equal(core.hasCapacityLimit("翻訳を保存しました。"), false);
});

test("does not nudge while ChatGPT still exposes an active generation", () => {
  const decision = core.decideAction({
    enabled: true,
    generating: true,
    interrupted: true,
    capacityLimited: false,
    completed: false
  });
  assert.deepEqual(decision, {
    action: "wait",
    reason: "connection_interrupted_but_still_generating"
  });
});

test("automatically recovers after a delivery timeout stays frozen for 180 seconds", () => {
  const base = {
    enabled: true,
    generating: true,
    interrupted: true,
    deliveryTimedOut: true,
    stableForMs: 179999,
    silentStallMs: 180000,
    nudgeCount: 1,
    maxNudges: 20
  };
  assert.deepEqual(core.decideAction(base), {
    action: "wait",
    reason: "connection_interrupted_but_still_generating"
  });
  assert.deepEqual(core.decideAction({ ...base, stableForMs: 180000 }), {
    action: "recover_stuck",
    reason: "delivery_timeout_stuck_generating"
  });
});

test("automatically recovers when a tool response stays generating without any visible change", () => {
  const base = {
    enabled: true,
    generating: true,
    interrupted: false,
    deliveryTimedOut: false,
    lastRole: "assistant",
    hasToolActivity: true,
    composerReady: true,
    stableForMs: 179999,
    silentStallMs: 180000,
    nudgeCount: 2,
    maxNudges: 20
  };
  assert.deepEqual(core.decideAction(base), { action: "wait", reason: "generating" });
  assert.deepEqual(core.decideAction({ ...base, stableForMs: 180000 }), {
    action: "recover_stuck",
    reason: "generation_stuck_no_change"
  });
});

test("elapsed tool clocks do not reset the no-progress timer but new output does", () => {
  const earlier = "Worked for 14m 40s\nEncountered exception: <class 'caas.internal.errors.ClientError'>.";
  const later = "Worked for 14m 43s\nEncountered exception: <class 'caas.internal.errors.ClientError'>.";
  const newOutput = `${later}\nprint('next')`;
  const key = text => core.makeTurnKey({ id: "assistant-1", text: core.progressText(text) });
  assert.equal(key(earlier), key(later));
  assert.notEqual(key(later), key(newOutput));
});

test("an unfinished ClientError tool response gets the 180-second recovery window", () => {
  const text = "Worked for 14m 40s\nEncountered exception: <class 'caas.internal.errors.ClientError'>.";
  assert.equal(core.hasUnfinishedToolError(text), true);
  assert.equal(core.hasUnfinishedToolError(`${text}\n訳出を再開します。`), false);
  assert.equal(core.isSilentStallCandidate({
    lastRole: "assistant", generating: false, composerReady: true,
    hasResponseActions: false, hasToolActivity: false, unfinishedToolError: true
  }), true);
  const state = {
    enabled: true, generating: true, lastRole: "assistant", composerReady: true,
    hasToolActivity: false, unfinishedToolError: true,
    stableForMs: 180000, silentStallMs: 180000,
    nudgeCount: 0, maxNudges: 20
  };
  assert.deepEqual(core.decideAction(state), {
    action: "recover_stuck", reason: "generation_stuck_no_change"
  });
});

test("content monitor executes the verified stop-and-nudge recovery automatically", () => {
  const contentSource = fs.readFileSync(path.join(__dirname, "..", "content.js"), "utf8");
  assert.match(
    contentSource,
    /if \(decision\.action === "recover_stuck"\)[\s\S]{0,900}await recoverStuckResponse\(\);/
  );
});

test("does not classify a text-only long generation as a frozen tool response", () => {
  assert.deepEqual(core.decideAction({
    enabled: true,
    generating: true,
    interrupted: false,
    deliveryTimedOut: false,
    lastRole: "assistant",
    hasToolActivity: false,
    composerReady: true,
    stableForMs: 300000,
    silentStallMs: 180000,
    nudgeCount: 0,
    maxNudges: 20
  }), { action: "wait", reason: "generating" });
});

test("never offers stuck-timeout recovery past the nudge safety limit", () => {
  assert.deepEqual(core.decideAction({
    enabled: true,
    generating: true,
    interrupted: true,
    deliveryTimedOut: true,
    stableForMs: 180000,
    silentStallMs: 180000,
    nudgeCount: 20,
    maxNudges: 20
  }), { action: "pause", reason: "nudge_limit" });
});

test("recognizes the current ChatGPT delivery-timeout wording", () => {
  assert.equal(core.hasTransientInterruption("Message delivery timed out. Please try again."), true);
  assert.equal(core.hasDeliveryTimeout("Message delivery timed out. Please try again."), true);
  assert.equal(core.hasDeliveryTimeout("Connection interrupted. Waiting for the complete answer"), false);
});

test("recognizes only the exact Thinking failed control label", () => {
  assert.equal(core.hasThinkingFailureLabel("Thinking failed"), true);
  assert.equal(core.hasThinkingFailureLabel("Thinking failed."), true);
  assert.equal(core.hasThinkingFailureLabel("Thinking failed を説明します"), false);
  const contentSource = fs.readFileSync(path.join(__dirname, "..", "content.js"), "utf8");
  assert.match(contentSource, /lastTurn\?\.role !== "assistant" \|\| hasResponseActions/);
  assert.match(contentSource, /button\.closest\('\.markdown, \.whitespace-pre-wrap, pre, code, blockquote'\)/);
  assert.match(contentSource, /recoverCurrentTurn = recoverTimedOutTurn \|\| recoverSilentStall \|\| snap\.thinkingFailed/);
  assert.match(contentSource, /if \(existingDraft\) throw new Error\("入力欄に下書きがあるため/);
});

test("recognizes exact Analysis errored control but not quoted prose", () => {
  assert.equal(core.hasAnalysisErrorLabel("Analysis errored"), true);
  assert.equal(core.hasAnalysisErrorLabel("Analysis errored."), true);
  assert.equal(core.hasAnalysisErrorLabel("The page says Analysis errored"), false);
  assert.equal(core.isSilentStallCandidate({
    lastRole: "assistant", generating: false, deliveryTimedOut: false,
    composerReady: true, hasResponseActions: false,
    hasToolActivity: false, analysisFailed: true
  }), true);
  assert.equal(core.isSilentStallCandidate({
    lastRole: "assistant", generating: false, deliveryTimedOut: false,
    composerReady: true, hasResponseActions: true,
    hasToolActivity: false, analysisFailed: true
  }), false);
});

test("Analysis errored waits 180 seconds of unchanged visible activity", () => {
  const base = {
    enabled: true, generating: false, lastRole: "assistant",
    assistantKey: "assistant-analysis", lastHandledAssistantKey: null,
    silentStalled: true, analysisFailed: true,
    stableForMs: 179999, silentStallMs: 180000,
    nudgeCount: 0, maxNudges: 20
  };
  assert.deepEqual(core.decideAction(base), { action: "wait", reason: "settling" });
  assert.deepEqual(core.decideAction({ ...base, stableForMs: 180000 }),
    { action: "nudge", reason: "silent_stall" });
  assert.deepEqual(core.decideAction({ ...base, stableForMs: 180000,
    lastHandledAssistantKey: "assistant-analysis" }),
  { action: "wait", reason: "assistant_turn_already_handled" });
});

test("Stream cache expired with Retry is a once-per-turn bounded recovery", () => {
  assert.equal(core.hasStreamCacheExpiredLabel("Stream cache expired"), true);
  assert.equal(core.hasStreamCacheExpiredLabel("Stream cache expired."), true);
  assert.equal(core.hasStreamCacheExpiredLabel("The error is Stream cache expired"), false);
  const base = {
    enabled: true, streamCacheFailure: true,
    streamCacheTurnKey: "assistant-stream", lastRetriedStreamTurnKey: null,
    streamCacheDraftSafe: true, stableForMs: 4999,
    deliveryTimeoutMs: 5000, nudgeCount: 0, maxNudges: 20
  };
  assert.deepEqual(core.decideAction(base), { action: "wait", reason: "settling" });
  assert.deepEqual(core.decideAction({ ...base, stableForMs: 5000 }),
    { action: "retry_stream_cache", reason: "stream_cache_expired" });
  assert.deepEqual(core.decideAction({ ...base, stableForMs: 5000,
    lastRetriedStreamTurnKey: "assistant-stream" }),
  { action: "wait", reason: "stream_cache_retry_already_attempted" });
  assert.deepEqual(core.decideAction({ ...base, stableForMs: 5000,
    streamCacheDraftSafe: false }),
  { action: "wait", reason: "draft_protected" });
});

test("Resume stream unavailable uses the same bounded Retry without matching prose", () => {
  assert.equal(core.hasStreamCacheExpiredLabel("Resume stream unavailable"), true);
  assert.equal(core.hasStreamCacheExpiredLabel("Resume stream unavailable."), true);
  assert.equal(core.hasStreamCacheExpiredLabel("Resume stream unavailable を説明します"), false);
  assert.equal(core.hasStreamCacheExpiredLabel("Encountered exception: ClientError"), false);
  const state = {
    enabled: true, streamCacheFailure: true, streamCacheTurnKey: "resume-turn",
    streamCacheDraftSafe: true, stableForMs: 5000, deliveryTimeoutMs: 5000,
    nudgeCount: 0, maxNudges: 20
  };
  assert.equal(core.decideAction(state).action, "retry_stream_cache");
  assert.equal(core.decideAction({ ...state, streamCacheDraftSafe: false }).action, "wait");
  assert.equal(core.decideAction({ ...state, lastRetriedStreamTurnKey: "resume-turn" }).action, "wait");
});

test("stream Retry requires the latest assistant error control, not quoted prose", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "content.js"), "utf8");
  const start = source.indexOf("  function findStreamCacheRetry(");
  const end = source.indexOf("  function hasThinkingFailureIndicator(", start);
  const label = { textContent: "Resume stream unavailable", contains: () => false,
    closest: () => null, querySelector: () => null };
  const row = { children: [label], childNodes: [], querySelector: () => null };
  const retry = { parentElement: row };
  const turn = { role: "assistant", node: { querySelectorAll: () => [] } };
  const context = { core, visible: () => true, elementText: node => node?.textContent || "",
    Node: { TEXT_NODE: 3 }, turn, retry };
  const run = () => vm.runInNewContext(`${source.slice(start, end)}\nfindStreamCacheRetry(turn, retry)`, context);
  assert.equal(run(), retry);
  context.retry = null;
  assert.equal(run(), null);
  context.retry = retry;
  turn.role = "user";
  assert.equal(run(), null);
  turn.role = "assistant";
  row.querySelector = () => ({ className: "markdown" });
  turn.node.querySelectorAll = () => [{ textContent: "Resume stream unavailable Retry",
    contains: () => true, closest: () => ({ className: "markdown" }), querySelector: () => null }];
  assert.equal(run(), null);
});

test("translation stream Retry clicks once and persists the attempt before clicking", async () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "content.js"), "utf8");
  const start = source.indexOf("  async function retryStreamCacheFailure(");
  const end = source.indexOf("  async function recoverStuckResponse(", start);
  const failed = { streamCacheFailure: true, streamCacheDraftSafe: true,
    streamCacheTurnKey: "resume-turn", lastTurnKey: "old" };
  let snap = failed;
  let clicks = 0;
  const session = { nudgeCount: 0 };
  const retry = { click() {
    assert.equal(session.lastRetriedStreamTurnKey, "resume-turn");
    clicks++;
    snap = { streamCacheFailure: false, generating: true, lastTurnKey: "resumed" };
  } };
  const context = { route: { kind: "conversation" }, config: { maxNudges: 20 }, session,
    snapshot: () => snap, findStreamCacheRetry: () => retry, findRetryButton: () => retry,
    saveSession: async update => Object.assign(session, update),
    waitFor: async predicate => predicate(), statusPayload: () => session };
  const run = () => vm.runInNewContext(`${source.slice(start, end)}\nretryStreamCacheFailure()`, context);
  await run();
  snap = failed;
  await assert.rejects(run(), /すでに試みました/);
  assert.equal(clicks, 1);
  assert.equal(session.nudgeCount, 1);
});

test("recovery latches the stable assistant turn before send or Retry", () => {
  assert.equal(core.makeStableTurnKey({ id: "assistant-1", text: "one" }),
    core.makeStableTurnKey({ id: "assistant-1", text: "one two" }));
  assert.notEqual(core.makeTurnKey({ id: "assistant-1", text: "one" }),
    core.makeTurnKey({ id: "assistant-1", text: "one two" }));
  const source = fs.readFileSync(path.join(__dirname, "..", "content.js"), "utf8");
  const nudge = source.slice(source.indexOf("async function nudgeNow"), source.indexOf("async function retryStreamCacheFailure"));
  assert.ok(nudge.indexOf("lastHandledAssistantKey: snap.assistantKey") < nudge.indexOf("await submitPrompt(config.prompt)"));
  const retry = source.slice(source.indexOf("async function retryStreamCacheFailure"), source.indexOf("async function recoverStuckResponse"));
  assert.ok(retry.indexOf("lastRetriedStreamTurnKey: snap.streamCacheTurnKey") < retry.indexOf("retryButton.click()"));
});

test("recovers a stopped Thinking failed turn after the short grace period only once", () => {
  const base = {
    enabled: true,
    generating: false,
    capacityLimited: false,
    completed: false,
    terminalErrorBlocked: false,
    stopOnTerminalError: true,
    deliveryTimedOut: false,
    thinkingFailed: true,
    lastRole: "assistant",
    assistantKey: "assistant-thinking:abcd",
    lastHandledAssistantKey: null,
    settleMs: 20000,
    silentStallMs: 180000,
    deliveryTimeoutMs: 5000,
    nudgeCount: 0,
    maxNudges: 20
  };
  assert.deepEqual(core.decideAction({ ...base, stableForMs: 4999 }), { action: "wait", reason: "settling" });
  assert.deepEqual(core.decideAction({ ...base, stableForMs: 5000 }), { action: "nudge", reason: "thinking_failed" });
  assert.deepEqual(core.decideAction({ ...base, stableForMs: 5000, generating: true }), { action: "wait", reason: "generating" });
  assert.deepEqual(core.decideAction({ ...base, stableForMs: 5000, lastHandledAssistantKey: base.assistantKey }), { action: "wait", reason: "assistant_turn_already_handled" });
});

test("recognizes retryable send failures attached to the user turn", () => {
  assert.equal(core.hasRetryableSendFailure("Something went wrong. Please try again."), true);
  assert.equal(core.hasRetryableSendFailure("エラーが発生しました。もう一度お試しください。"), true);
  assert.equal(core.hasRetryableSendFailure("保存済みの続きからお願いします。"), false);
});

test("retries a failed user-turn submission once after the short grace period", () => {
  const base = {
    enabled: true,
    generating: false,
    retryableSendFailure: true,
    retryTurnKey: "user-20:abcd",
    lastRetriedTurnKey: null,
    lastRole: "user",
    stableForMs: 4999,
    deliveryTimeoutMs: 5000
  };
  assert.deepEqual(core.decideAction(base), { action: "wait", reason: "settling" });
  assert.deepEqual(core.decideAction({ ...base, stableForMs: 5000 }), {
    action: "retry_failed_submission",
    reason: "retryable_send_failure"
  });
  assert.deepEqual(core.decideAction({
    ...base,
    stableForMs: 10000,
    lastRetriedTurnKey: "user-20:abcd"
  }), { action: "wait", reason: "retry_already_attempted" });
});

test("explicit Retry failure wins over a stale generating control", () => {
  assert.deepEqual(core.decideAction({
    enabled: true,
    generating: true,
    retryableSendFailure: true,
    retryTurnKey: "user-21:efgh",
    lastRetriedTurnKey: "user-20:abcd",
    lastRole: "user",
    stableForMs: 5000,
    deliveryTimeoutMs: 5000
  }), {
    action: "retry_failed_submission",
    reason: "retryable_send_failure"
  });
});

test("content monitor clicks Retry through the bounded failed-submission recovery", () => {
  const contentSource = fs.readFileSync(path.join(__dirname, "..", "content.js"), "utf8");
  assert.match(
    contentSource,
    /if \(decision\.action === "retry_failed_submission"\)[\s\S]{0,200}await retryFailedSubmission\(\);/
  );
  assert.match(contentSource, /lastRetriedTurnKey/);
  assert.match(contentSource, /const generating = rawGenerating && !retryableSendFailure/);
  assert.match(contentSource, /retryable-send-failure/);
});

test("recovers the frequent delivery timeout after its shorter grace period", () => {
  const base = {
    enabled: true,
    generating: false,
    capacityLimited: false,
    completed: false,
    terminalErrorBlocked: false,
    stopOnTerminalError: true,
    deliveryTimedOut: true,
    lastRole: "assistant",
    assistantKey: "assistant-timeout:abcd",
    lastHandledAssistantKey: "assistant-previous:efgh",
    settleMs: 20000,
    deliveryTimeoutMs: 5000,
    nudgeCount: 1,
    maxNudges: 20
  };
  assert.deepEqual(core.decideAction({ ...base, stableForMs: 4999 }), {
    action: "wait",
    reason: "settling"
  });
  assert.deepEqual(core.decideAction({ ...base, stableForMs: 5000 }), {
    action: "nudge",
    reason: "delivery_timeout"
  });
});

test("recognizes a structural silent stall without relying on message wording", () => {
  assert.equal(core.isSilentStallCandidate({
    lastRole: "assistant",
    generating: false,
    deliveryTimedOut: false,
    composerReady: true,
    hasToolActivity: true,
    hasResponseActions: false
  }), true);
  assert.equal(core.isSilentStallCandidate({
    lastRole: "assistant",
    generating: false,
    deliveryTimedOut: false,
    composerReady: true,
    hasToolActivity: true,
    hasResponseActions: true
  }), false);
  assert.equal(core.isSilentStallCandidate({
    lastRole: "assistant",
    generating: true,
    deliveryTimedOut: false,
    composerReady: true,
    hasToolActivity: true,
    hasResponseActions: false
  }), false);
});

test("recognizes an invalidated Chrome extension context", () => {
  assert.equal(
    core.isExtensionContextInvalidated(new Error("Extension context invalidated.")),
    true
  );
  assert.equal(core.isExtensionContextInvalidated("Could not establish connection."), false);
});

test("gives a silent stall a 180 second default grace period", () => {
  assert.equal(core.normalizeConfig({}).silentStallSeconds, 180);
  const base = {
    enabled: true,
    generating: false,
    capacityLimited: false,
    completed: false,
    terminalErrorBlocked: false,
    stopOnTerminalError: true,
    deliveryTimedOut: false,
    silentStalled: true,
    lastRole: "assistant",
    assistantKey: "assistant-silent:abcd",
    lastHandledAssistantKey: "assistant-previous:efgh",
    settleMs: 20000,
    silentStallMs: 180000,
    deliveryTimeoutMs: 5000,
    nudgeCount: 1,
    maxNudges: 20
  };
  assert.deepEqual(core.decideAction({ ...base, stableForMs: 179999 }), {
    action: "wait",
    reason: "settling"
  });
  assert.deepEqual(core.decideAction({ ...base, stableForMs: 180000 }), {
    action: "nudge",
    reason: "silent_stall"
  });
});

test("detects explicit terminal error blockers but not recoverable errors", () => {
  assert.equal(core.hasTerminalErrorBlocker("エラーのため、これ以上翻訳作業を続けられません。"), true);
  assert.equal(core.hasTerminalErrorBlocker("I cannot continue because the tool returned an error."), true);
  assert.equal(core.hasTerminalErrorBlocker("Message delivery timed out. Please try again."), false);
  assert.equal(core.hasTerminalErrorBlocker("エラーを修正したので、このまま続けます。"), false);
  assert.equal(core.hasTerminalErrorBlocker("この会話は容量上限に達しました。"), false);
});

test("waits for generation to end before stopping on a terminal error", () => {
  assert.deepEqual(core.decideAction({
    enabled: true,
    generating: true,
    interrupted: false,
    terminalErrorBlocked: true,
    stopOnTerminalError: true
  }), { action: "wait", reason: "generating" });
});

test("thanks and stops after a stable explicit terminal error", () => {
  assert.deepEqual(core.decideAction({
    enabled: true,
    generating: false,
    capacityLimited: false,
    completed: false,
    terminalErrorBlocked: true,
    stopOnTerminalError: true,
    lastRole: "assistant",
    assistantKey: "assistant-11:abcd",
    lastHandledAssistantKey: "assistant-10:efgh",
    stableForMs: 21000,
    settleMs: 20000,
    nudgeCount: 3,
    maxNudges: 20
  }), { action: "thank_and_stop", reason: "terminal_error_blocker" });
});

test("nudges a new stable assistant turn", () => {
  const decision = core.decideAction({
    enabled: true,
    generating: false,
    capacityLimited: false,
    completed: false,
    lastRole: "assistant",
    assistantKey: "assistant-9:abcd",
    lastHandledAssistantKey: "assistant-8:efgh",
    nudgeCount: 2,
    maxNudges: 20,
    stableForMs: 21000,
    settleMs: 20000
  });
  assert.deepEqual(decision, { action: "nudge", reason: "assistant_stopped" });
});

test("completion marker stops the monitor before a nudge", () => {
  const decision = core.decideAction({
    enabled: true,
    capacityLimited: false,
    completed: true,
    generating: false
  });
  assert.deepEqual(decision, { action: "complete", reason: "completion_marker" });
});

test("capacity rollover requires a verified project context", () => {
  assert.deepEqual(core.decideAction({
    enabled: true,
    capacityLimited: true,
    rolloverEnabled: true,
    projectSlug: "g-p-example"
  }), { action: "rollover", reason: "conversation_capacity" });

  assert.deepEqual(core.decideAction({
    enabled: true,
    capacityLimited: true,
    rolloverEnabled: true,
    projectSlug: null
  }), { action: "pause", reason: "capacity_without_safe_rollover" });
});

test("rollover prompt names the project, source, safeguards, and emoji", () => {
  const prompt = core.buildRolloverPrompt({
    config: { projectName: "翻訳" },
    sourceUrl: "https://chatgpt.com/g/g-p-example/c/old",
    lastUserText: "続けて",
    lastAssistantText: "C036まで保存済み"
  });
  assert.match(prompt, /同じ『翻訳』プロジェクト/);
  assert.match(prompt, /manifest・checkpoint/);
  assert.match(prompt, /github\.com\/yamaizumiminoru\/translations/);
  assert.match(prompt, /原典の権威はこのChatGPTプロジェクトにアップロードされたPDF/);
  assert.match(prompt, /記憶だけで進捗や本文を推測しない/);
  assert.match(prompt, /C036まで保存済み/);
  assert.match(prompt, /👏🍵/);
  assert.match(prompt, /🙏/);
});
