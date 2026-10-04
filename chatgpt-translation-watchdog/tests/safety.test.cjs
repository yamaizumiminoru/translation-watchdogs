const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const core = require('../watchdog-core');
const SHA1 = 'a'.repeat(40), SHA2 = 'b'.repeat(40);
const base = { enabled: true, now: 1000000, generating: true, interrupted: true,
  stableForMs: 500000, silentStallMs: 180000, composerReady: true,
  lastRole: 'assistant', hasToolActivity: true, nudgeCount: 0, maxNudges: 20 };

function observe(previous, values) {
  return core.updateEvidence(previous, { observedAt: 1000000, readStatus: 'ok',
    gitSha: SHA1, gitSavedAt: 100, manifestStatus: 'incomplete', ...values });
}

test('stale UI/network error with a new commit waits without Stop, nudge, or rollover', () => {
  const prior = observe({}, { observedAt: 900000, gitSavedAt: 800000 });
  const evidence = observe(prior, { gitSha: SHA2, gitSavedAt: 990000 });
  assert.equal(evidence.lastActualActivityAt, 990000);
  assert.deepEqual(core.decideAction({ ...base, evidence }), { action: 'wait', reason: 'recent_actual_activity' });
});

test('completed manifest overrides spinner, capacity limit, retry error, and pending prompt', () => {
  const evidence = observe({}, { manifestStatus: 'complete' });
  assert.deepEqual(core.decideAction({ ...base, evidence, capacityLimited: true,
    retryableSendFailure: true, streamCacheFailure: true, receipt: { sentAt: 5 } }),
    { action: 'complete', reason: 'saved_manifest_complete' });
  assert.equal(observe(evidence, { manifestStatus: 'incomplete', gitSha: SHA2 }).manifestStatus, 'complete');
  assert.equal(observe(evidence, { readStatus: 'failed' }).manifestStatus, 'complete');
});

test('completion marker also outranks every UI recovery signal', () => {
  assert.deepEqual(core.decideAction({ ...base, completed: true, capacityLimited: true,
    streamCacheFailure: true }), { action: 'complete', reason: 'completion_marker' });
});

test('failed read is unknown, never idle or permission to continue', () => {
  const evidence = observe(observe({}, {}), { readStatus: 'failed' });
  assert.equal(evidence.manifestStatus, 'unknown');
  assert.deepEqual(core.decideAction({ ...base, evidence, generating: false }),
    { action: 'wait', reason: 'evidence_read_failed' });
});

test('re-reading the same old commit updates only observation time, not activity or saved time', () => {
  const prior = observe({}, { observedAt: 900000 });
  const evidence = observe(prior, {});
  assert.equal(evidence.observedAt, 1000000);
  assert.equal(evidence.lastGitSavedAt, 100);
  assert.equal(evidence.lastGitSavedSHA, SHA1);
  assert.equal(evidence.lastActualActivityAt, undefined);
});

test('persisted prompt without execution evidence blocks another recovery', () => {
  const receipt = { sentAt: 100, displayedAt: 101, persistedAt: 102, executedAt: null };
  assert.deepEqual(core.decideAction({ ...base, generating: false, receipt }),
    { action: 'wait', reason: 'execution_unverified' });
});

test('a spinner, elapsed counter, and empty assistant shell cannot establish execution', () => {
  const source = fs.readFileSync(require.resolve('../content.js'), 'utf8');
  assert.match(source, /activityKey: actualOutput \? core.makeTurnKey/);
  assert.equal(core.progressText('Worked for 12h 53m'), core.progressText('Worked for 12h 54m'));
  assert.equal(core.progressText('Worked for 14m 40s'), core.progressText('Worked for 14m 41s'));
  assert.notEqual(core.progressText('saved page 1'), core.progressText('saved page 2'));
});

test('stale incomplete evidence expires instead of authorizing indefinite retries', () => {
  assert.deepEqual(core.decideAction({ ...base, generating: false, silentStalled: true,
    evidence: { manifestStatus: 'incomplete', gitObservedAt: 1 } }),
    { action: 'wait', reason: 'saved_state_unknown' });
});

test('bounded exponential backoff and rollover budget survive successive observations', () => {
  assert.equal(core.recoveryBackoffMs(0), 20000);
  assert.equal(core.recoveryBackoffMs(1), 40000);
  assert.equal(core.recoveryBackoffMs(99), 900000);
  assert.deepEqual(core.decideAction({ ...base, nextRecoveryAt: 1000001 }),
    { action: 'wait', reason: 'recovery_backoff' });
  assert.deepEqual(core.decideAction({ ...base, generating: false, interrupted: false,
    capacityLimited: true, rolloverCount: 1 }), { action: 'pause', reason: 'nudge_limit' });
});

test('malformed, future-save, and out-of-order observations cannot fabricate completion', () => {
  assert.equal(observe({}, { gitSha: 'bad', manifestStatus: 'complete' }).manifestStatus, undefined);
  assert.equal(observe({}, { gitSavedAt: 1000001, manifestStatus: 'complete' }).manifestStatus, undefined);
  const prior = observe({}, {});
  assert.equal(observe(prior, { observedAt: 999999, manifestStatus: 'complete' }), prior);
});

test('approval and login waits never auto-continue', () => {
  for (const flag of ['awaitingApproval', 'awaitingLogin']) {
    assert.deepEqual(core.decideAction({ ...base, [flag]: true }), { action: 'wait', reason: 'human_action_required' });
  }
});

test('completed jobs reject manual nudge and explicit Stop before any side effect', async () => {
  const source = fs.readFileSync(require.resolve('../content.js'), 'utf8');
  const session = { completionConfirmed: true, status: 'stuck_timeout', nudgeCount: 0 };
  let clicks = 0;
  const context = { core, session, route: { kind: 'conversation' }, config: core.DEFAULTS,
    snapshot: () => ({ observationKey: 'same', completed: true }),
    findGeneratingButton: () => ({ click: () => clicks++ }) };
  let start = source.indexOf('  async function recoverStuckResponse(');
  let end = source.indexOf('  async function retryFailedSubmission(', start);
  const stop = vm.runInNewContext(`${source.slice(start,end)}\nrecoverStuckResponse`, context);
  await assert.rejects(stop({ confirmed: true, observationKey: 'same' }), /完了済み/);
  start = source.indexOf('  async function nudgeNow(');
  end = source.indexOf('  async function retryStreamCacheFailure(', start);
  const nudge = vm.runInNewContext(`${source.slice(start,end)}\nnudgeNow`, context);
  await assert.rejects(nudge(), /完了済み/);
  assert.equal(clicks, 0);
});

test('manual Stop rejects stale authorization, pending receipt, and protected draft', async () => {
  const source = fs.readFileSync(require.resolve('../content.js'), 'utf8');
  const start = source.indexOf('  async function recoverStuckResponse(');
  const end = source.indexOf('  async function retryFailedSubmission(', start);
  const session = { status: 'stuck_timeout', nudgeCount: 0, receipt: { sentAt: 5 } };
  let draftText = '', clicks = 0;
  const context = { session, route: { kind: 'conversation' }, config: core.DEFAULTS,
    snapshot: () => ({ observationKey: 'current', draftText }),
    findGeneratingButton: () => ({ click: () => clicks++ }) };
  const stop = vm.runInNewContext(`${source.slice(start,end)}\nrecoverStuckResponse`, context);
  await assert.rejects(stop({ confirmed: true, observationKey: 'old' }), /停止の確認/);
  await assert.rejects(stop({ confirmed: true, observationKey: 'current' }), /実行は未確認/);
  session.receipt = null; draftText = 'user draft';
  await assert.rejects(stop({ confirmed: true, observationKey: 'current' }), /下書き/);
  assert.equal(clicks, 0);
});

test('receipt execution is correlated to this request, never unrelated Git or another turn', () => {
  const receipt = { sentAt: 100, displayedAt: 101, userTurnId: 'request-2', executedAt: null };
  const unrelatedGit = observe(observe({}, {}), { gitSha: SHA2, gitSavedAt: 999000 });
  assert.equal(core.observeReceipt(receipt, unrelatedGit), receipt);
  assert.equal(core.observeReceipt(receipt, { observedAt: 110, activityKey: 'output', afterUserTurnId: 'request-1' }), receipt);
  assert.equal(core.observeReceipt(receipt, { observedAt: 110, activityKey: null, afterUserTurnId: 'request-2' }), receipt);
  const confirmed = core.observeReceipt(receipt, { observedAt: 110, activityKey: 'actual-output', afterUserTurnId: 'request-2' });
  assert.equal(confirmed.executedAt, 110);
  assert.equal(confirmed.persistedAt, undefined);
});

test('stream Retry requires changed output from the exact retried assistant', () => {
  const receipt = { sentAt: 100, targetAssistantId: 'assistant-2', baselineActivityKey: 'old-output' };
  for (const observation of [
    { assistantId: 'assistant-2', activityKey: 'old-output' },
    { assistantId: 'assistant-1', activityKey: 'new-output' },
    { assistantId: 'assistant-2', activityKey: null }
  ]) assert.equal(core.observeReceipt(receipt, { observedAt: 110, ...observation }), receipt);
  assert.equal(core.observeReceipt(receipt, { observedAt: 110, assistantId: 'assistant-2', activityKey: 'new-output' }).executedAt, 110);
});

test('popup status exposes the exact observation key consumed by explicit Stop authorization', () => {
  const source = fs.readFileSync(require.resolve('../content.js'), 'utf8');
  const start = source.indexOf('  function statusPayload()');
  const end = source.indexOf('  chrome.runtime.onMessage', start);
  const result = vm.runInNewContext(`${source.slice(start,end)}\nstatusPayload()`, {
    route: { kind: 'conversation' }, session: {}, config: {}, snapshot: () => ({ observationKey: 'same-screen' })
  });
  assert.equal(result.snapshot.observationKey, 'same-screen');
  const popup = fs.readFileSync(require.resolve('../popup.js'), 'utf8');
  assert.match(popup, /observationKey: current\?\.snapshot\?\.observationKey/);
  assert.match(source, /recoverStuckResponse\(message.authorization\)/);
});

test('rollover restores the correlated receipt only in its verified target conversation', async () => {
  const source = fs.readFileSync(require.resolve('../content.js'), 'utf8');
  const start = source.indexOf('  async function resumePendingRollover()');
  const end = source.indexOf('  async function tick()', start);
  const receipt = { sentAt: Date.now() - 1000, displayedAt: Date.now() - 999, userTurnId: 'handoff-user' };
  const pending = { createdAt: Date.now(), projectSlug: 'same-project', stage: 'submitted',
    targetConversationId: 'target', receipt, nudgeCount: 2 };
  const writes = [];
  let removed = false;
  const context = { core, PENDING_ROLLOVER_KEY: 'pending', ROLLOVER_TTL_MS: 100000,
    route: { kind: 'conversation', conversationId: 'wrong', projectSlug: 'same-project' },
    session: {}, storageGet: async () => ({ pending }),
    storageSet: async value => writes.push(value), storageRemove: async () => { removed = true; },
    defaultSession: () => ({}), sessionStorageKey: () => 'target-session', updateBadge: () => {},
    snapshot: () => ({ turns: [{ role: 'user', id: 'handoff-user' }] }) };
  const resume = vm.runInNewContext(`${source.slice(start,end)}\nresumePendingRollover`, context);
  assert.equal(await resume(), false);
  assert.equal(writes.length, 0);
  context.route.conversationId = 'target';
  pending.targetConversationId = null;
  assert.equal(await resume(), false); // fallback user IDs can collide across conversations
  assert.equal(writes.length, 0);
  pending.targetConversationId = 'target';
  assert.equal(await resume(), true);
  assert.equal(removed, true);
  assert.equal(writes[0]['target-session'].receipt.userTurnId, 'handoff-user');
  assert.equal(writes[0]['target-session'].nudgeCount, 2);
  assert.ok(core.observeReceipt(writes[0]['target-session'].receipt, {
    observedAt: Date.now(), afterUserTurnId: 'handoff-user', activityKey: 'actual output'
  }).executedAt);
  assert.match(source, /pending.receipt = \{ \.\.\.session.receipt \}/);
});
