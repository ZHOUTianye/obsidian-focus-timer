const VIEW_TYPE = "focus-timer-view";
const MAX_SUGGEST_TASKS = 100;
/** 专注事项 / 联想任务：英文字符上限 */
const FOCUS_NOTE_MAX_ASCII = 100;
/** 专注事项 / 联想任务：非英文字符上限（如中文） */
const FOCUS_NOTE_MAX_OTHER = 50;
/** 快捷 timer 名称：英文字符上限 */
const QUICK_TIMER_MAX_ASCII = 40;
/** 快捷 timer 名称：非英文字符上限 */
const QUICK_TIMER_MAX_OTHER = 10;

function nowISO() { return new Date().toISOString(); }
function clamp0(n) { return Math.max(0, n); }

module.exports = {
  VIEW_TYPE,
  MAX_SUGGEST_TASKS,
  FOCUS_NOTE_MAX_ASCII,
  FOCUS_NOTE_MAX_OTHER,
  QUICK_TIMER_MAX_ASCII,
  QUICK_TIMER_MAX_OTHER,
  nowISO,
  clamp0
};
