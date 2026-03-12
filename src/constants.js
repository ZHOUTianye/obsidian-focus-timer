const VIEW_TYPE = "focus-timer-view";
const MAX_SUGGEST_TASKS = 100;

function nowISO() { return new Date().toISOString(); }
function clamp0(n) { return Math.max(0, n); }

module.exports = { VIEW_TYPE, MAX_SUGGEST_TASKS, nowISO, clamp0 };
