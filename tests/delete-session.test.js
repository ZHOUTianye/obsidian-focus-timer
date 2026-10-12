const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const originalLoad = Module._load;
class Element {
  constructor() { this.children = []; this.attributes = {}; }
  empty() { this.children = []; }
  setText(text) { this.text = text; }
  addClass() {}
  setAttribute(key, value) { this.attributes[key] = value; }
  createEl(tag, options = {}) { const child = new Element(); Object.assign(child, options, { tag }); this.children.push(child); return child; }
  createDiv(options) { return this.createEl('div', options); }
}
class Base {
  constructor(app) { this.app = app; this.contentEl = new Element(); this.titleEl = new Element(); }
  open() { Base.lastModal = this; this.onOpen(); }
  close() { this.closed = true; this.onClose(); }
}
Module._load = function(id, ...args) {
  if (id === 'obsidian') return { ItemView: Base, Modal: Base, Component: Base,
    Notice: class {}, setIcon(el, name) { el.icon = name; }, getLanguage: () => 'en' };
  return originalLoad.call(this, id, ...args);
};
const { deleteSession, appendSession, readSessions, writeSessions } = require('../src/data');
const { FocusTimerView } = require('../src/view');
const { calculateStats } = require('../src/stats');
const { calculateChartData } = require('../src/chart');
const { getDefaultDataTemplate } = require('../src/core');
const row = (id, status = 'completed') => ({ id, start: new Date().toISOString(),
  actualSec: 120, status, note: 'task', customOldField: 'preserved' });
function fixture() {
  const original = { ...getDefaultDataTemplate(), sessions: [row('a'), row('b', 'abandoned')],
    state: { active: true, resting: false, start: '2026-01-01', note: 'running' } };
  let raw = JSON.stringify(original);
  const events = [];
  const app = { vault: { adapter: { exists: async () => true, read: async () => raw,
    write: async (_, value) => { raw = value; } } }, workspace: { trigger: event => events.push(event) } };
  return { app, events, original, data: () => JSON.parse(raw) };
}
test('delete completed or abandoned record preserves state/settings/other legacy rows', async () => {
  for (const id of ['a', 'b']) {
    const f = fixture();
    assert.equal(await deleteSession(f.app, id), true);
    assert.deepEqual(f.data().state, f.original.state);
    assert.deepEqual(f.data().settings, f.original.settings);
    assert.deepEqual(f.data().sessions, f.original.sessions.filter(s => s.id !== id));
    assert.deepEqual(f.events, ['focus-timer:sessions-changed']);
    assert.equal(await deleteSession(f.app, id), false);
    assert.equal(f.events.length, 1);
  }
});
test('concurrent append/delete uses freshest file and survives re-read', async () => {
  const f = fixture();
  await Promise.all([deleteSession(f.app, 'a'), appendSession(f.app, row('c'))]);
  assert.deepEqual((await readSessions(f.app)).map(s => s.id), ['b', 'c']);
});
test('write failure does not change data or send refresh event', async () => {
  const f = fixture();
  f.app.vault.adapter.write = async () => { throw new Error('disk failure'); };
  await assert.rejects(deleteSession(f.app, 'a'), /disk failure/);
  assert.deepEqual(f.data(), f.original);
  assert.deepEqual(f.events, []);
});
test('record trash icon opens confirmation; cancel leaves file untouched; confirm deletes', async () => {
  const f = fixture();
  const view = Object.create(FocusTimerView.prototype);
  view.plugin = { app: f.app };
  const root = new Element();
  view.createRecentHistory(root, f.data().sessions);
  const item = root.children[0].children.find(el => el.children.some(c => c.icon === 'trash-2'));
  const trash = item.children.find(c => c.icon === 'trash-2');
  assert.equal(trash.attributes['aria-label'], 'Delete focus record');
  trash.onclick();
  let modal = Base.lastModal;
  const buttons = modal.contentEl.children[1];
  buttons.children[0].onclick();
  assert.deepEqual(f.data(), f.original);
  trash.onclick(); modal = Base.lastModal;
  await modal.contentEl.children[1].children[1].onclick();
  assert.equal(f.data().sessions.length, 1);
});
test('all history clear publishes event and completed totals/chart drop to zero', async () => {
  const f = fixture();
  assert.ok(calculateChartData(f.data().sessions, '7天').some(point => point.value > 0));
  await writeSessions(f.app, []);
  assert.equal(f.events.length, 1);
  assert.equal((await readSessions(f.app)).length, 0);
  assert.ok(calculateStats([]));
  assert.ok(calculateChartData([], '7天').every(point => point.value === 0));
});
