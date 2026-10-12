/** Focus time excludes pauses; old states without pause fields remain valid. */
function focusElapsedMs(state, now = Date.now()) {
  const start = Date.parse(state.start);
  if (!Number.isFinite(start)) return 0;
  const pausedAt = Date.parse(state.pausedAt);
  const end = state.paused === true && Number.isFinite(pausedAt) ? pausedAt : now;
  const pausedMs = Number.isFinite(state.pausedMs) ? Math.max(0, state.pausedMs) : 0;
  return Math.max(0, end - start - pausedMs);
}

function pauseFocusState(state, now = Date.now()) {
  if (!state.active || state.resting || state.paused) return null;
  return { ...state, paused: true, pausedAt: new Date(now).toISOString() };
}

function resumeFocusState(state, now = Date.now()) {
  if (!state.active || state.resting || !state.paused) return null;
  const pausedAt = Date.parse(state.pausedAt);
  const pausedMs = (Number.isFinite(state.pausedMs) ? Math.max(0, state.pausedMs) : 0)
    + (Number.isFinite(pausedAt) ? Math.max(0, now - pausedAt) : 0);
  const next = { ...state, paused: false, pausedAt: null, pausedMs };
  if (state.plannedSec != null) {
    next.end = new Date(now + Math.max(0, state.plannedSec * 1000 - focusElapsedMs(next, now))).toISOString();
  }
  return next;
}

module.exports = { focusElapsedMs, pauseFocusState, resumeFocusState };
