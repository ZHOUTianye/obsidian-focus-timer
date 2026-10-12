const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const originalLoad = Module._load;
class Base { constructor(app) { this.app = app; } }
Module._load = function(id, ...args) {
  if (id === 'obsidian') return {
    Plugin: Base, Component: Base, ItemView: Base, Modal: Base,
    PluginSettingTab: Base, Setting: Base, Notice: class {}, getLanguage: () => 'en'
  };
  return originalLoad.call(this, id, ...args);
};
const Plugin = require('../src/plugin');
const { FocusTimerView } = require('../src/view');
const { DATA_PATH, getDefaultDataTemplate } = require('../src/core');
const { focusElapsedMs, pauseFocusState, resumeFocusState } = require('../src/timer-state');

function fixture(state = {}, sessions = []) {
  let raw = JSON.stringify({ ...getDefaultDataTemplate(), state, sessions });
  const events = [];
  const app = { vault: { adapter: {
    exists: async () => true,
    read: async () => raw,
    write: async (path, value) => { assert.equal(path, DATA_PATH); raw = value; }
  } }, workspace: { trigger: event => events.push(event), getLeavesOfType: () => [] } };
  const plugin = new Plugin(app);
  plugin.updateTickingState = () => {};
  plugin.updateView = () => {};
  return { app, plugin, events, data: () => JSON.parse(raw) };
}
const start = '2026-01-01T00:00:00.000Z';
const origin = Date.parse(start);
const active = (mode = 'stopwatch') => ({ active: true, resting: false, start, mode,
  plannedSec: mode === 'countdown' ? 60 : null, note: 'task' });

test('old states and malformed optional pause fields have safe elapsed time', () => {
  assert.equal(focusElapsedMs(active(), origin + 10000), 10000);
  assert.equal(focusElapsedMs({ ...active(), pausedMs: -30 }, origin - 10), 0);
  assert.equal(focusElapsedMs({ start: 'bad' }), 0);
});

for (const mode of ['stopwatch', 'countdown']) {
  test(`${mode}: repeated pauses freeze clock, resume shifts countdown deadline`, () => {
    let s = active(mode);
    for (let cycle = 0; cycle < 20; cycle++) {
      const now = origin + cycle * 15000 + 5000;
      s = pauseFocusState(s, now);
      assert.equal(focusElapsedMs(s, now + 10000), (cycle + 1) * 5000);
      assert.equal(pauseFocusState(s, now), null);
      s = resumeFocusState(s, now + 10000);
      assert.equal(s.pausedMs, (cycle + 1) * 10000);
      assert.equal(resumeFocusState(s, now), null);
      if (mode === 'countdown') assert.ok(Date.parse(s.end) >= now + 10000);
    }
  });
  test(`${mode}: persisted pause freezes after restart; completion excludes downtime`, async () => {
    const paused = pauseFocusState(active(mode), origin + 12000);
    const f = fixture(JSON.parse(JSON.stringify(paused)));
    f.plugin.settings.allowCompleteCountdownEarly = true;
    await f.plugin.syncLocalTimerState();
    assert.equal(focusElapsedMs(f.plugin.focusState, origin + 86400000), 12000);
    await f.plugin.stopFocus('completed');
    assert.equal(f.data().sessions[0].actualSec, 12);
    assert.equal(f.data().state.active, false);
    assert.ok(f.events.includes('focus-timer:sessions-changed'));
  });
  test(`${mode}: paused abandonment excludes pause time`, async () => {
    const f = fixture(pauseFocusState(active(mode), origin + 7000));
    await f.plugin.stopFocus('abandoned');
    assert.equal(f.data().sessions[0].actualSec, 7);
    assert.equal(f.data().sessions[0].status, 'abandoned');
  });
}

test('paused expired countdown cannot auto-complete; early complete policy stays enforced', async () => {
  const f = fixture(pauseFocusState(active('countdown'), origin + 5000));
  await f.plugin.syncLocalTimerState();
  await f.plugin.handleAutoStop();
  await f.plugin.stopFocus('completed', true);
  await f.plugin.stopFocus('completed');
  assert.equal(f.data().sessions.length, 0);
  assert.equal(f.data().state.active, true);
});

test('rapid pause/resume/complete calls serialize and create one record', async () => {
  const f = fixture(active());
  await Promise.all([f.plugin.setFocusPaused(true), f.plugin.setFocusPaused(true),
    f.plugin.setFocusPaused(false), f.plugin.stopFocus('completed'), f.plugin.stopFocus('completed')]);
  assert.equal(f.data().sessions.length, 1);
  assert.equal(f.data().state.active, false);
});

test('save failure preserves timer and records, emits no committed mutation event', async () => {
  const f = fixture(active());
  const before = f.data();
  f.app.vault.adapter.write = async () => { throw new Error('disk failure'); };
  assert.equal(await f.plugin.setFocusPaused(true), false);
  assert.equal(await f.plugin.stopFocus('completed'), false);
  assert.deepEqual(f.data(), before);
  assert.deepEqual(f.events, []);
});

test('complete starts rest atomically; rest expiration remains wall-clock based', async () => {
  const f = fixture(pauseFocusState(active(), origin + 3000));
  f.plugin.settings.autoRest = true;
  await f.plugin.stopFocus('completed');
  assert.equal(f.data().state.resting, true);
  assert.equal(f.data().state.paused, false);
  await f.plugin.stopRest();
  assert.equal(f.data().state.resting, false);
});

test('native View and status bar display use paused effective time', async () => {
  const f = fixture(pauseFocusState(active(), origin + 9000));
  const view = Object.create(FocusTimerView.prototype);
  Object.assign(view, { plugin: f.plugin, startTime: origin, focusState: f.data().state,
    timerMode: 'stopwatch', restStartTime: null, timerElements: { timeEl: {} } });
  view.updateTimerDisplay();
  assert.equal(view.timerElements.timeEl.textContent, '00:09');
  let text;
  f.plugin.statusBarEl = { addClass() {}, setText(value) { text = value; } };
  await f.plugin.updateStatusBarDisplay();
  assert.ok(text.includes('Paused 00:09'));
});

test('running restart includes downtime, paused countdown View stays frozen', async () => {
  const f = fixture({ ...active('countdown'), start: new Date(Date.now() - 5000).toISOString() });
  await f.plugin.syncLocalTimerState();
  assert.ok(focusElapsedMs(f.plugin.focusState) >= 5000);
  await f.plugin.setFocusPaused(true);
  const view = Object.create(FocusTimerView.prototype);
  Object.assign(view, { plugin: f.plugin, startTime: Date.parse(f.data().state.start),
    focusState: f.data().state, plannedSec: 60, timerMode: 'countdown', restStartTime: null,
    timerElements: { timeEl: {} } });
  view.updateTimerDisplay();
  assert.equal(view.timerElements.timeEl.textContent, '00:55');
});

test('expired running countdown completes; autoContinue keeps it running', async () => {
  for (const autoContinue of [false, true]) {
    const f = fixture(active('countdown'));
    f.plugin.settings.autoContinue = autoContinue;
    await f.plugin.syncLocalTimerState();
    await f.plugin.handleAutoStop();
    assert.equal(f.data().state.active, autoContinue);
    assert.equal(f.data().sessions.length, autoContinue ? 0 : 1);
  }
});

test('pause queued before automatic completion wins the race', async () => {
  const f = fixture(active('countdown'));
  await Promise.all([f.plugin.setFocusPaused(true), f.plugin.stopFocus('completed', true)]);
  assert.equal(f.data().state.paused, true);
  assert.equal(f.data().sessions.length, 0);
});

test('a new timer clears accumulated pause fields; rest cannot be paused', async () => {
  const f = fixture({ ...active(), active: false, paused: true, pausedMs: 5000 });
  await f.plugin.startFocus(null, 'stopwatch');
  assert.equal(f.data().state.pausedMs, 0);
  assert.equal(f.data().state.paused, false);
  await f.plugin.stopFocus('abandoned');
  await f.plugin.startRest();
  assert.equal(await f.plugin.setFocusPaused(true), false);
  assert.equal(f.data().state.resting, true);
});
