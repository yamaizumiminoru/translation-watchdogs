const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');
const core = require('../watchdog-core.js');
const dom = require('../dom.js');
const source = name => fs.readFileSync(path.join(__dirname, '..', name), 'utf8');
const url = 'https://chatgpt.com/c/aaa-bbb';
const sessionKey = 'errorWatchdog:conversation:aaa-bbb';

function worker(stored = {}) {
  let listener;
  const chrome = {
    storage: { local: {
      async get(keys) { return Object.fromEntries(keys.map(key => [key, structuredClone(stored[key])])); },
      async set(values) { Object.assign(stored, structuredClone(values)); }
    } },
    runtime: { onMessage: { addListener(fn) { listener = fn; } } },
    action: { async setBadgeText() {}, async setBadgeBackgroundColor() {} }
  };
  vm.runInNewContext(source('background.js'), {
    chrome, importScripts() {}, ChatGPTErrorWatchdogCore: core, URL, console
  });
  const request = (message, tabId = 1, tabUrl = url) => new Promise(resolve => listener(
    { conversationId: 'aaa-bbb', ...message }, { tab: { id: tabId, url: tabUrl } }, resolve
  ));
  return { stored, request };
}
function turn(role, id, body = '', error = '') {
  return `<article data-testid="conversation-turn-${id}" data-turn="${role}"><div data-message-author-role="${role}" data-message-id="message-${id}"><div class="${role === 'user' ? 'whitespace-pre-wrap' : 'markdown'}">${body}</div></div>${error}</article>`;
}
const generic = '<div role="alert"><span>Something went wrong. Please try again.</span><button>Retry</button></div>';
const liveFailedUserTurn = `<section data-testid="conversation-turn-9" data-turn="user">
  <div data-message-author-role="user" data-message-id="earlier"><div class="whitespace-pre-wrap">終わっタイムアウト？</div></div>
  <div data-message-author-role="user" data-message-id="failed"><div class="whitespace-pre-wrap">Error in message stream って出てるけど、続けて</div>
    <div><div>Something went wrong. Please try again.</div>
      <button data-testid="regenerate-thread-error-button">Retry</button></div>
  </div>
</section>`;
const timeout = '<div role="alert">Message delivery timed out. Please try again.</div>';
const thinkingFailure = '<button aria-expanded="false">Thinking failed</button>';
const streamFailure = '<div><span>Resume stream unavailable</span><div><button>Retry</button></div></div>';
const composer = '<form><div id="prompt-textarea" contenteditable="true"></div><button data-testid="send-button">Send</button></form>';
test('shared current turn-key separates user and assistant and isolates error UI', () => {
  const p = page(`<div data-turn-key="shared"><div><div data-chatgpt-search-unit-key="fallback-turn-0:0:user"><div data-user-message-bubble>依頼</div></div></div>
    <div><div data-chatgpt-search-unit-key="fallback-turn-0:2:assistant"><div class="markdown">途中</div></div>${streamFailure}</div></div>`);
  let snap = dom.snapshot(p.doc);
  assert.equal(snap.turnCount, 2);
  assert.equal(snap.userCount, 1);
  assert.equal(snap.lastRole, 'assistant');
  assert.equal(snap.error.kind, 'stream');
  assert.equal(snap.retryReady, true);
  const id = snap.errorKey;
  p.doc.querySelector('.markdown').textContent += ' 新しい進捗';
  assert.equal(dom.snapshot(p.doc).errorKey, id);
  p.doc.querySelector('[data-turn-key]').insertAdjacentHTML('beforeend', '<div><div data-chatgpt-search-unit-key="fallback-turn-0:4:user"><div data-user-message-bubble>新しい依頼</div></div></div>');
  snap = dom.snapshot(p.doc);
  assert.equal(snap.lastRole, 'user');
  assert.equal(snap.error, null);
  p.close();
});
function page(html, service = worker(), run = false, options = {}) {
  const page = new JSDOM(`<main>${html}</main>${options.composerHtml || composer}`, { url, runScripts: 'outside-only', pretendToBeVisual: true });
  const w = page.window;
  w.HTMLElement.prototype.getBoundingClientRect = () => ({ x: 0, y: 0, width: 100, height: 20 });
  let clock = 1000000;
  let interval;
  let messageListener;
  w.Date.now = () => clock;
  w.setInterval = fn => { interval = fn; return 1; };
  w.clearInterval = () => {};
  w.setTimeout = (fn, ms) => { clock += ms; queueMicrotask(fn); return 2; };
  w.chrome = { runtime: { sendMessage: msg => service.request(msg), onMessage: { addListener(fn) { messageListener = fn; } } } };
  w.eval(source('watchdog-core.js'));
  w.eval(source('dom.js'));
  if (options.trustedProgrammaticInput) {
    let inputListener;
    const addEventListener = w.document.addEventListener.bind(w.document);
    w.document.addEventListener = (type, listener, settings) => {
      if (type === 'input') inputListener = listener;
      return addEventListener(type, listener, settings);
    };
    w.document.execCommand = (_command, _showUi, value) => {
      const input = w.document.querySelector('#prompt-textarea');
      input.textContent = value;
      inputListener?.({ isTrusted: true, target: input });
      if (options.trustedUserEditAfterFill) queueMicrotask(() => {
        input.textContent += ' 手入力';
        inputListener?.({ isTrusted: true, target: input });
      });
      return true;
    };
  }
  if (run) w.eval(source('content.js'));
  const drain = async () => { for (let i = 0; i < 30; i++) await new Promise(resolve => setImmediate(resolve)); };
  return { w, doc: w.document, service, drain, async tick(ms = 6000) { clock += ms; interval(); await drain(); },
    async command(type) { return new Promise(resolve => messageListener({ type }, {}, resolve)); }, close() { w.close(); } };
}

test('all conversation URL forms share identity, project home does not arm', () => {
  for (const prefix of ['', '/g/g-p-example', '/g/g-custom']) assert.equal(core.route(`https://chatgpt.com${prefix}/c/aaa-bbb`)?.conversationId, 'aaa-bbb');
  assert.equal(core.route('https://chatgpt.com/g/g-p-example/project'), null);
  assert.equal(core.route('https://example.org/c/aaa-bbb'), null);
});
test('supported errors have appropriate generic prompts with emoji, no project binding', () => {
  const samples = [['Message delivery timed out. Please try again.', 'timeout'], ['Connection interrupted. Waiting for the complete answer', 'interrupted'], ['Network error', 'network'], ['Something went wrong. Please try again.', 'generic'], ['Error in message stream', 'generic'], ['Thinking failed', 'thinking']];
  for (const [text, kind] of samples) {
    assert.equal(core.classify(text), kind);
    assert.match(core.prompt(kind), /👏🍵/);
    assert.match(core.prompt(kind), /続けてください🙏/);
    assert.doesNotMatch(core.prompt(kind), /翻訳|github|PDF|TRANSLATION/);
  }
  assert.equal(core.classify('Something went wrong. Please try again. を説明します'), null);
  assert.equal(core.classify('Error in message stream って出た'), null);
  assert.equal(core.classify('Too many requests. Please try again.'), 'blocked');
});
test('message-stream error is read only from visible latest-turn error UI', () => {
  const p = page(turn('user', 1, '作業を続けて') + turn('assistant', 2, '途中', '<div role="alert">Error in message stream</div>'));
  assert.equal(dom.snapshot(p.doc).error?.kind, 'generic');
  for (const html of [
    turn('assistant', 2, 'Error in message stream'),
    turn('assistant', 2, '途中', '<div hidden role="alert">Error in message stream</div>'),
    turn('assistant', 2, '途中', '<div role="alert">Error in message stream</div>') + turn('user', 3, 'この表示は？')
  ]) {
    p.doc.querySelector('main').innerHTML = html;
    assert.equal(dom.snapshot(p.doc).error, null);
  }
  p.close();
});
test('failed user send with a native Retry keeps the original request', () => {
  const p = page(turn('user', 1, '作業を続けて',
    '<div><div>Error in message stream</div><button data-testid="regenerate-thread-error-button">Retry</button></div>'));
  const snap = dom.snapshot(p.doc);
  assert.equal(snap.error?.kind, 'generic');
  assert.equal(snap.retryReady, true);
  assert.equal(core.decide({ ...snap, enabled: true, count: 0, maxRecoveries: 10,
    stableMs: 5000, graceSeconds: 5 }).action, 'retry');
  p.close();
});
test('message-stream error prompts once, preserving the current task', async () => {
  const s = worker({ [sessionKey]: { enabled: true, count: 0, attempted: [] } });
  const p = page(turn('user', 1, 'Watchdogの修正を続けて') +
    turn('assistant', 2, '途中', '<div role="alert">Error in message stream</div>'), s, true);
  const sent = [];
  p.doc.querySelector('[data-testid=send-button]').addEventListener('click', event => {
    event.preventDefault();
    const input = p.doc.querySelector('#prompt-textarea');
    sent.push(input.textContent);
    p.doc.querySelector('main').insertAdjacentHTML('beforeend', turn('user', 3, input.textContent));
    input.textContent = '';
  });
  await p.drain();
  await p.tick();
  await p.tick();
  assert.deepEqual(sent, [core.prompt('generic')]);
  assert.equal(s.stored[sessionKey].count, 1);
  p.close();
});
test('stream resume failure is an exact Retry-only error label', () => {
  assert.equal(core.classify('Resume stream unavailable'), 'stream');
  assert.equal(core.classify('Resume stream unavailable.'), 'stream');
  assert.equal(core.classify('Stream cache expired'), 'stream');
  assert.equal(core.classify('Resume stream unavailable を説明します'), null);
  assert.equal(core.classify('Encountered exception: ClientError'), null);
  const state = { enabled: true, error: { kind: 'stream' }, lastRole: 'assistant',
    retryReady: true, generating: true, count: 0, maxRecoveries: 10,
    stableMs: 5000, graceSeconds: 5, composerReady: true };
  assert.equal(core.decide(state).action, 'retry');
  assert.equal(core.decide({ ...state, stableMs: 4999 }).action, 'wait');
  assert.equal(core.decide({ ...state, retryReady: false }).action, 'wait');
  for (const guard of ['draft', 'attachments', 'userBusy', 'attempted']) {
    assert.equal(core.decide({ ...state, [guard]: true }).action, 'wait');
  }
});
test('stream error row pairs only with nearby Retry in the latest assistant turn', () => {
  const p = page(turn('assistant', 1, '途中', streamFailure));
  assert.equal(dom.snapshot(p.doc).error?.kind, 'stream');
  assert.equal(dom.snapshot(p.doc).retryReady, true);
  for (const html of [
    turn('assistant', 1, 'Resume stream unavailable', '<button>Retry</button>'),
    turn('assistant', 1, '途中', '<div hidden>' + streamFailure + '</div>'),
    turn('assistant', 1, '途中', '<div role="alert">Resume stream unavailable</div><button>Retry</button>'),
    turn('user', 1, '途中', streamFailure),
    turn('assistant', 1, '途中', streamFailure) + turn('assistant', 2, '完了')
  ]) {
    p.doc.querySelector('main').innerHTML = html;
    assert.equal(dom.snapshot(p.doc).error, null);
  }
  p.close();
});
test('current turn-key markup recognizes stream error and keeps a stable incident identity', () => {
  const p = page('<section data-turn-key="turn-current"><div data-chatgpt-search-unit-key="current:0:assistant"><div class="markdown">途中</div></div>' + streamFailure + '</section>');
  const before = dom.snapshot(p.doc);
  assert.equal(before.error?.kind, 'stream');
  assert.equal(before.errorKey, 'turn-current:error');
  p.doc.querySelector('.markdown').textContent += ' 進捗';
  assert.equal(dom.snapshot(p.doc).errorKey, before.errorKey);
  assert.notEqual(dom.snapshot(p.doc).progress, before.progress);
  p.close();
});
test('stream Retry is persisted once across reload and never fills a continuation prompt', async () => {
  const s = worker({ [sessionKey]: { enabled: true, count: 0, attempted: [] } });
  let clicks = 0;
  for (let i = 0; i < 2; i++) {
    const p = page(turn('assistant', 1, '途中', streamFailure), s, true);
    p.doc.querySelector('article button').addEventListener('click', () => clicks++);
    await p.drain();
    await p.tick();
    await p.tick();
    assert.equal(p.doc.querySelector('#prompt-textarea').textContent, '');
    p.close();
  }
  assert.equal(clicks, 1);
  assert.equal(s.stored[sessionKey].status, 'paused');
});
test('stream Retry leaves unrelated drafts and attachments untouched', async () => {
  const s = worker({ [sessionKey]: { enabled: true, count: 0, attempted: [] } });
  const p = page(turn('assistant', 1, '途中', streamFailure), s, true);
  let clicks = 0;
  p.doc.querySelector('article button').addEventListener('click', () => clicks++);
  p.doc.querySelector('#prompt-textarea').textContent = '保存しておく下書き';
  await p.drain();
  await p.tick();
  assert.equal(clicks, 0);
  assert.equal(s.stored[sessionKey].count, 0);
  assert.equal(p.doc.querySelector('#prompt-textarea').textContent, '保存しておく下書き');
  p.doc.querySelector('#prompt-textarea').textContent = '';
  p.doc.querySelector('form').insertAdjacentHTML('beforeend', '<button aria-label="Remove attachment">file.pdf</button>');
  await p.tick();
  assert.equal(clicks, 0);
  assert.equal(s.stored[sessionKey].count, 0);
  p.close();
});
test('assistant stream Retry resumes without a new prompt despite a stale stop control', async () => {
  const s = worker({ [sessionKey]: { enabled: true, count: 0, attempted: [] } });
  const p = page(turn('assistant', 1, '途中', streamFailure) + '<button data-testid="stop-button">Stop</button>', s, true);
  let clicks = 0;
  p.doc.querySelector('article button').addEventListener('click', () => {
    clicks++;
    p.doc.querySelector('article').lastElementChild.remove();
  });
  await p.drain();
  await p.tick();
  assert.equal(clicks, 1);
  assert.equal(p.doc.querySelector('#prompt-textarea').textContent, '');
  assert.equal(s.stored[sessionKey].status, 'sent');
  p.close();
});
test('normal completion and quoted errors never trigger', () => {
  for (const body of ['作業は完了しました。', 'Something went wrong. Please try again.', '<pre>Message delivery timed out. Please try again.</pre>']) {
    const p = page(turn('assistant', 1, body));
    assert.equal(dom.snapshot(p.doc).error, null);
    assert.equal(core.decide({ enabled: true, ...dom.snapshot(p.doc), stableMs: 600000 }).action, 'wait');
    p.close();
  }
});
test('only latest turn error matters; hidden and nested transcript errors are ignored', () => {
  const p = page(turn('assistant', 1, '', timeout) + turn('assistant', 2, '完了'));
  assert.equal(dom.snapshot(p.doc).error, null);
  p.doc.querySelector('main').innerHTML = turn('assistant', 3, '<div role="alert">Something went wrong. Please try again.</div>', '<div hidden role="alert">Network error</div>');
  assert.equal(dom.snapshot(p.doc).error, null);
  p.close();
});
test('latest user Retry and assistant timeout detected from realistic turn markup', () => {
  const p = page(turn('user', 1, '依頼', generic));
  assert.equal(dom.snapshot(p.doc).error.kind, 'generic');
  assert.equal(dom.snapshot(p.doc).retryReady, true);
  p.doc.querySelector('main').innerHTML = turn('assistant', 2, '途中です', timeout);
  assert.equal(dom.snapshot(p.doc).error.kind, 'timeout');
  p.close();
});
test('unmarked ChatGPT error beside native Retry is detected inside a multi-message user turn', () => {
  const p = page(liveFailedUserTurn);
  const snap = dom.snapshot(p.doc);
  assert.equal(snap.error.kind, 'generic');
  assert.equal(snap.errorKey, 'failed:error');
  assert.equal(snap.retryReady, true);
  assert.equal(core.decide({ enabled: true, ...snap, count: 0, maxRecoveries: 10, graceSeconds: 5, stableMs: 6000 }).action, 'retry');
  p.close();
});
test('latest assistant Thinking failed control is recoverable, but quotations and completed answers are not', () => {
  const p = page(turn('user', 1, '続けて') + turn('assistant', 2, '', thinkingFailure));
  let snap = dom.snapshot(p.doc);
  assert.equal(snap.error.kind, 'thinking');
  assert.equal(core.decide({ enabled: true, ...snap, count: 0, maxRecoveries: 10, graceSeconds: 5, stableMs: 6000 }).action, 'prompt');
  p.doc.querySelector('main').innerHTML = turn('assistant', 3, 'Thinking failed');
  assert.equal(dom.snapshot(p.doc).error, null);
  p.doc.querySelector('main').innerHTML = turn('assistant', 4, '回答済み', thinkingFailure + '<div aria-label="Response actions"><button aria-label="Copy response">Copy</button></div>');
  assert.equal(dom.snapshot(p.doc).error, null);
  p.doc.querySelector('main').innerHTML = turn('assistant', 5, '', thinkingFailure) + '<button data-testid="stop-button">Stop</button>';
  snap = dom.snapshot(p.doc);
  assert.equal(core.decide({ enabled: true, ...snap, count: 0, maxRecoveries: 10, graceSeconds: 5, stableMs: 6000 }).action, 'wait');
  p.close();
});
test('quoted error in user prose is ignored even when a native Retry exists elsewhere', () => {
  const p = page(turn('user', 1, 'Something went wrong. Please try again.', '<div><button data-testid="regenerate-thread-error-button">Retry</button></div>'));
  assert.equal(dom.snapshot(p.doc).error, null);
  p.close();
});
test('body progress changes, but the incident id survives message growth', () => {
  const p = page(turn('assistant', 1, '途中', timeout));
  const before = dom.snapshot(p.doc);
  p.doc.querySelector('.markdown').textContent = '途中の追加';
  const after = dom.snapshot(p.doc);
  assert.equal(before.errorKey, after.errorKey);
  assert.notEqual(before.progress, after.progress);
  p.close();
});
test('unformatted body quotation with unrelated Retry is not an error UI', () => {
  const p = page('<article data-testid="conversation-turn-1" data-turn="assistant"><div data-message-author-role="assistant"><p>Something went wrong. Please try again.</p></div><button>Retry</button></article>');
  assert.equal(dom.snapshot(p.doc).error, null);
  p.close();
});
test('non-form composer attachment chips beyond the immediate parents are protected', () => {
  const p = page(turn('assistant', 1, '', timeout));
  p.doc.querySelector('form').outerHTML = '<div id="thread-bottom-container"><div data-testid="attachment">image.png</div><div><div><div id="prompt-textarea" contenteditable="true"></div></div></div></div>';
  assert.equal(dom.snapshot(p.doc).attachments, true);
  p.close();
});
test('drafts and attachments are detected without modifying them', () => {
  const p = page(turn('assistant', 1, '', timeout));
  p.doc.querySelector('#prompt-textarea').textContent = '書きかけ';
  assert.equal(dom.snapshot(p.doc).draft, true);
  p.doc.querySelector('form').insertAdjacentHTML('beforeend', '<button aria-label="Remove attachment">file.pdf</button>');
  assert.equal(dom.snapshot(p.doc).attachments, true);
  assert.equal(p.doc.querySelector('#prompt-textarea').textContent, '書きかけ');
  p.close();
});
test('generation is preserved; only explicit failed-user Retry overrides stale stop', () => {
  const state = { enabled: true, error: { kind: 'generic' }, generating: true, lastRole: 'assistant', count: 0, maxRecoveries: 10, stableMs: 10000, graceSeconds: 5, composerReady: true };
  assert.equal(core.decide(state).action, 'wait');
  assert.equal(core.decide({ ...state, lastRole: 'user', retryReady: true }).action, 'retry');
  assert.equal(core.decide({ ...state, lastRole: 'user', retryReady: false }).action, 'wait');
  for (const protection of ['draft', 'attachments', 'userBusy', 'attempted']) assert.equal(core.decide({ ...state, generating: false, [protection]: true }).action, 'wait');
});
test('two tabs and restarted worker claim same incident exactly once', async () => {
  const s = worker();
  await s.request({ type: 'EW_SET_ENABLED', enabled: true });
  const result = await Promise.all([s.request({ type: 'EW_CLAIM', errorKey: 'm1:error' }, 1), s.request({ type: 'EW_CLAIM', errorKey: 'm1:error' }, 2, 'https://chatgpt.com/g/g-p-example/c/aaa-bbb')]);
  assert.equal(result.filter(x => x.allowed).length, 1);
  assert.equal(s.stored[sessionKey].count, 1);
  assert.equal((await worker(s.stored).request({ type: 'EW_CLAIM', errorKey: 'm1:error' })).allowed, false);
});
test('wrong conversation is rejected and repeated failures have bounded budget', async () => {
  const s = worker();
  assert.equal((await s.request({ type: 'EW_STATE', conversationId: 'other' })).ok, false);
  await s.request({ type: 'EW_SET_CONFIG', config: { maxRecoveries: 1 } });
  await s.request({ type: 'EW_SET_ENABLED', enabled: true });
  assert.equal((await s.request({ type: 'EW_CLAIM', errorKey: 'first' })).allowed, true);
  assert.equal((await s.request({ type: 'EW_CLAIM', errorKey: 'second' })).allowed, false);
});
test('content executes user Retry once and never writes an extra prompt', async () => {
  const s = worker({ [sessionKey]: { enabled: true, count: 0, attempted: [] } });
  const p = page(turn('user', 1, '元の依頼', generic), s, true);
  let clicks = 0;
  p.doc.querySelector('article button').addEventListener('click', () => {
    clicks++;
    p.doc.querySelector('[role=alert]').remove();
    p.doc.querySelector('main').insertAdjacentHTML('beforeend', turn('assistant', 2, '再開中'));
  });
  await p.drain();
  await p.tick();
  await p.tick();
  assert.equal(clicks, 1);
  assert.equal(p.doc.querySelector('#prompt-textarea').textContent, '');
  assert.equal(s.stored[sessionKey].count, 1);
  p.close();
});
test('content retries the live unmarked user-send error only once', async () => {
  const s = worker({ [sessionKey]: { enabled: true, count: 0, attempted: [] } });
  const p = page(liveFailedUserTurn, s, true);
  let clicks = 0;
  p.doc.querySelector('[data-testid=regenerate-thread-error-button]').addEventListener('click', () => {
    clicks++;
    p.doc.querySelector('[data-message-id=failed] > div:last-child').remove();
    p.doc.querySelector('main').insertAdjacentHTML('beforeend', turn('assistant', 10, '再開中'));
  });
  await p.drain();
  await p.tick();
  await p.tick();
  assert.equal(clicks, 1);
  assert.equal(s.stored[sessionKey].count, 1);
  assert.equal(p.doc.querySelector('#prompt-textarea').textContent, '');
  p.close();
});
test('content sends error-specific encouragement on interrupted assistant answer', async () => {
  const s = worker({ [sessionKey]: { enabled: true, count: 0, attempted: [] } });
  const p = page(turn('user', 1, '元の依頼') + turn('assistant', 2, '途中', timeout), s, true);
  const sent = [];
  p.doc.querySelector('[data-testid=send-button]').addEventListener('click', event => {
    event.preventDefault();
    const input = p.doc.querySelector('#prompt-textarea');
    sent.push(input.textContent);
    p.doc.querySelector('main').insertAdjacentHTML('beforeend', turn('user', 3, input.textContent));
    input.textContent = '';
  });
  await p.drain();
  await p.tick();
  await p.tick();
  assert.equal(sent.length, 1);
  assert.equal(sent[0], core.prompt('timeout'));
  assert.equal(s.stored[sessionKey].count, 1);
  p.close();
});
test('content sends one thinking-failure continuation after the assistant stopped', async () => {
  const s = worker({ [sessionKey]: { enabled: true, count: 0, attempted: [] } });
  const p = page(turn('user', 1, '続けて') + turn('assistant', 2, '', thinkingFailure), s, true);
  const sent = [];
  p.doc.querySelector('[data-testid=send-button]').addEventListener('click', event => {
    event.preventDefault();
    const input = p.doc.querySelector('#prompt-textarea');
    sent.push(input.textContent);
    p.doc.querySelector('main').insertAdjacentHTML('beforeend', turn('user', 3, input.textContent));
    input.textContent = '';
  });
  await p.drain();
  await p.tick();
  await p.tick();
  assert.deepEqual(sent, [core.prompt('thinking')]);
  assert.equal(s.stored[sessionKey].count, 1);
  p.close();
});
test('own trusted insertText input does not cancel the pending send', async () => {
  const s = worker({ [sessionKey]: { enabled: true, count: 0, attempted: [] } });
  const p = page(turn('user', 1, '続けて') + turn('assistant', 2, '', thinkingFailure), s, true,
    { trustedProgrammaticInput: true });
  let clicks = 0;
  p.doc.querySelector('[data-testid=send-button]').addEventListener('click', event => {
    event.preventDefault();
    clicks++;
    p.doc.querySelector('main').insertAdjacentHTML('beforeend', turn('user', 3, '再開依頼'));
  });
  await p.drain();
  await p.tick();
  await p.tick();
  assert.equal(clicks, 1);
  p.close();
});
test('recognizes the current composer-submit-button as Send, but not Stop answering', () => {
  const p = page(turn('assistant', 1, '', thinkingFailure), worker(), false, {
    composerHtml: '<form><div id="prompt-textarea" contenteditable="true"></div><button id="composer-submit-button">↑</button></form>'
  });
  const button = p.doc.querySelector('#composer-submit-button');
  assert.equal(dom.send(p.doc), button);
  button.setAttribute('aria-label', 'Stop answering');
  assert.equal(dom.send(p.doc), null);
  p.close();
});
test('genuine user input after autofill still prevents the send', async () => {
  const s = worker({ [sessionKey]: { enabled: true, count: 0, attempted: [] } });
  const p = page(turn('user', 1, '続けて') + turn('assistant', 2, '', thinkingFailure), s, true,
    { trustedProgrammaticInput: true, trustedUserEditAfterFill: true });
  let clicks = 0;
  p.doc.querySelector('[data-testid=send-button]').addEventListener('click', () => clicks++);
  await p.drain();
  await p.tick();
  assert.equal(clicks, 0);
  assert.match(p.doc.querySelector('#prompt-textarea').textContent, /手入力$/);
  p.close();
});
test('unconfirmed Retry is persisted and not blindly clicked again after reload', async () => {
  const s = worker({ [sessionKey]: { enabled: true, count: 0, attempted: [] } });
  const html = turn('user', 1, '元の依頼', generic);
  let clicks = 0;
  for (let i = 0; i < 2; i++) {
    const p = page(html, s, true);
    p.doc.querySelector('article button').addEventListener('click', () => clicks++);
    await p.drain();
    await p.tick();
    await p.tick();
    p.close();
  }
  assert.equal(clicks, 1);
  assert.equal(s.stored[sessionKey].status, 'paused');
});
test('active draft prevents real send and claim until the user clears it', async () => {
  const s = worker({ [sessionKey]: { enabled: true, count: 0, attempted: [] } });
  const p = page(turn('assistant', 1, '途中', timeout), s, true);
  p.doc.querySelector('#prompt-textarea').textContent = '編集中';
  await p.drain();
  await p.tick();
  assert.equal(s.stored[sessionKey].count, 0);
  assert.equal(p.doc.querySelector('#prompt-textarea').textContent, '編集中');
  p.close();
});
test('answer progress during claim prevents an obsolete recovery', async () => {
  const s = worker({ [sessionKey]: { enabled: true, count: 0, attempted: [] } });
  const request = s.request;
  let p;
  s.request = async message => {
    const result = await request(message);
    if (message.type === 'EW_CLAIM') p.doc.querySelector('.markdown').textContent += ' 新しい進捗';
    return result;
  };
  p = page(turn('assistant', 1, '途中', timeout), s, true);
  let clicks = 0;
  p.doc.querySelector('[data-testid=send-button]').addEventListener('click', () => clicks++);
  await p.drain();
  await p.tick();
  assert.equal(clicks, 0);
  assert.equal(p.doc.querySelector('#prompt-textarea').textContent, '');
  assert.equal(s.stored[sessionKey].status, 'paused');
  p.close();
});
test('specific paused detail persists and an old report cannot re-enable monitoring', async () => {
  const s = worker();
  await s.request({ type: 'EW_SET_ENABLED', enabled: true });
  await s.request({ type: 'EW_REPORT', status: 'paused', detail: 'generic' });
  await s.request({ type: 'EW_REPORT', status: 'paused', detail: 'specific' });
  assert.equal(s.stored[sessionKey].detail, 'specific');
  await s.request({ type: 'EW_SET_ENABLED', enabled: false });
  await s.request({ type: 'EW_REPORT', status: 'recovering', detail: 'old' });
  assert.equal(s.stored[sessionKey].status, 'disabled');
  assert.equal(s.stored[sessionKey].enabled, false);
});
