const obsidian = require("obsidian");
const { Plugin, Notice, TFile, ItemView, WorkspaceLeaf, PluginSettingTab, Setting, MarkdownPostProcessor, Modal } = obsidian;
const moment = obsidian.moment || (typeof window !== "undefined" ? window.moment : null);

function pickLang(supported, fallback = "en") {
  const loc = ((moment && moment.locale && moment.locale()) || "").toLowerCase();
  if (supported.includes(loc)) return loc;
  const base = loc.split("-")[0];
  const hit = supported.find(x => x === base || x.startsWith(base + "-"));
  return hit ?? fallback;
}

const DATA_PATH = ".obsidian/plugins/focus-timer/data.json";

/**
 * 异步文件锁，保证对 data.json 的写入串行化，避免竞态条件。
 * 使用方式：await dataFileLock.runWithLock(async () => { ... 读-改-写 ... });
 */
class FileLock {
  constructor() {
    this._locked = false;
    this._queue = [];
  }

  acquire() {
    return new Promise((resolve) => {
      if (!this._locked) {
        this._locked = true;
        resolve();
      } else {
        this._queue.push(resolve);
      }
    });
  }

  release() {
    if (this._queue.length > 0) {
      const next = this._queue.shift();
      next();
    } else {
      this._locked = false;
    }
  }

  async runWithLock(fn) {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }
}

const dataFileLock = new FileLock();

/**
 * 定时器管理器：统一管理 setInterval/setTimeout，按 id 注册与清除，避免泄漏与重复。
 * 使用方式：plugin.timerManager.setInterval(id, ms, fn) / setTimeout(id, ms, fn)；clear(id)；onunload 时 clearAll()。
 */
class TimerManager {
  constructor() {
    this._timers = new Map(); // id -> { type: 'interval'|'timeout', handle: number }
  }

  setInterval(id, ms, fn) {
    this.clear(id);
    const handle = setInterval(fn, ms);
    this._timers.set(id, { type: "interval", handle });
    return id;
  }

  setTimeout(id, ms, fn) {
    this.clear(id);
    const handle = setTimeout(() => {
      this._timers.delete(id);
      fn();
    }, ms);
    this._timers.set(id, { type: "timeout", handle });
    return id;
  }

  clear(id) {
    const t = this._timers.get(id);
    if (t) {
      if (t.type === "interval") clearInterval(t.handle);
      else clearTimeout(t.handle);
      this._timers.delete(id);
    }
  }

  clearAll() {
    for (const [, t] of this._timers) {
      if (t.type === "interval") clearInterval(t.handle);
      else clearTimeout(t.handle);
    }
    this._timers.clear();
  }
}

/** 默认 data.json 模板（无 data.json 时创建，防止启动失败） */
function getDefaultDataTemplate() {
  return {
    state: { active: false, resting: false },
    sessions: [],
    settings: {
      autoContinue: false,
      defaultMode: "countdown",
      adjustStepMinutes: 5,
      defaultChartRange: "14天",
      defaultDurationMinutes: 25,
      quickTimer1: { name: "", minutes: 25 },
      quickTimer2: { name: "", minutes: 25 },
      quickTimer3: { name: "", minutes: 25 },
      autoRest: false,
      defaultRestMinutes: 5,
      keyboardShortcuts: false,
      statusBarShowFocus: true,
      allowCompleteCountdownEarly: false,
      suggestTasks: [],
      codeBlockChartShowTime: true,
      codeBlockChartShowCount: true
    }
  };
}

async function ensureDataFileExists(app) {
  await dataFileLock.runWithLock(async () => {
    const exists = await app.vault.adapter.exists(DATA_PATH);
    if (!exists) {
      await writeJson(app, DATA_PATH, getDefaultDataTemplate());
    }
  });
}
const VIEW_TYPE = "focus-timer-view";
const MAX_SUGGEST_TASKS = 100;

function nowISO() { return new Date().toISOString(); }
function clamp0(n) { return Math.max(0, n); }

// ========== 国际化支持 ==========
// 翻译对象
const translations = {
  zh: {
    // 通用
    cancel: "取消",
    delete: "删除",
    confirm: "确认",
    close: "关闭",
    start: "开始",
    complete: "完成",
    abandon: "放弃",
    download: "下载",
    
    // 状态
    idle: "空闲",
    resting: "休息中",
    focusing: "正在专注",
    countdown: "倒计时",
    stopwatch: "正计时",
    endRest: "结束休息",
    
    // 时间单位
    hour: "时",
    minute: "分钟",
    hourShort: " 时 ",
    minuteShort: " 分",
    
    // 统计
    todayFocus: "今日专注",
    todayCompleted: "今日完成",
    monthlyAvgFocus: "本月平均专注",
    yearlyTotalFocus: "全年总专注",
    focusHistory: "专注记录",
    recentFocus: "最近专注",
    chart: "图表",
    tasks: "个任务",
    yesterday: "昨天",
    lastMonth: "上月",
    avg7Days: "7天平均",
    monthlyAvg: "本月平均",
    yearlyTotal: "全年累计完成",
    yearlyTotalCompleted: "全年累计完成",
    oneTask: "一个任务",
    completed: "完成了",
    abandoned: "放弃了",
    today: "今天",
    
    // 设置
    timerSettings: "Timer设置",
    autoContinueAfterCountdown: "倒计时结束后自动继续计时",
    autoContinueDesc: "开启：倒计时结束时转为正计时继续计时。关闭：倒计时结束时自动完成该次专注。",
    statusBarShowFocus: "状态栏显示专注情况",
    statusBarShowFocusDesc: "开启时，状态栏会显示当前专注/休息的计时；关闭则不显示。",
    allowCompleteCountdownEarly: "倒计时允许提前完成",
    allowCompleteCountdownEarlyDesc: "关闭时，倒计时进行中只显示「放弃」按钮，命令「完成」也不可提前完成。",
    keyboardShortcuts: "使用键盘按键快捷操作",
    keyboardShortcutsDesc: "开启后，当专注计时器面板处于焦点时：按 Enter 立即开始；按「上」加时间；按「下」减时间。在输入框内输入时不会触发。",
    defaultMode: "默认模式",
    defaultModeDesc: "选择默认的计时模式",
    defaultDurationMinutes: "默认倒计时时间（分钟）",
    defaultDurationMinutesDesc: "设置默认的倒计时时长，不填写时默认为25分钟。只接受正整数。",
    adjustStepMinutes: "加/减按钮步长（分钟）",
    adjustStepMinutesDesc: "设置点击 + / - 按钮时每次增减的分钟数。只接受 1-60 的整数。",
    autoRest: "计时结束后自动进入休息",
    autoRestDesc: "开启后，专注完成时会自动开始休息",
    defaultRestMinutes: "默认休息时间（分钟）",
    defaultRestMinutesDesc: "当自动休息开启时，设置默认的休息时长，不填写时默认为5分钟。只接受正整数，最大600。",
    quickTimer: "快捷Timer",
    quickTimer1: "快捷Timer 1",
    quickTimer2: "快捷Timer 2",
    quickTimer3: "快捷Timer 3",
    quickTimerDesc: "设置第一个快捷timer的名称和倒计时时间（分钟）。英文字符最多40个。",
    quickTimerDesc2: "设置第二个快捷timer的名称和倒计时时间（分钟）。英文字符最多40个。",
    quickTimerDesc3: "设置第三个快捷timer的名称和倒计时时间（分钟）。英文字符最多40个。",
    timerName: "Timer名称",
    codeBlockChartSettings: "Focus 代码块图表默认设置",
    showFocusTime: "显示专注时间（代码块）",
    showFocusTimeDesc: "用于 focus 代码块中的折线图：是否默认显示专注时间",
    showTaskCount: "显示任务完成数量（代码块）",
    showTaskCountDesc: "用于 focus 代码块中的折线图：是否默认显示任务数量",
    defaultChartRange: "默认图表显示范围",
    defaultChartRangeDesc: "选择默认显示的图表时间范围，需要点击编辑代码块刷新。",
    days7: "7天",
    days14: "14天",
    days30: "30天",
    thisMonth: "本月",
    thisYear: "今年",
    
    // 图表
    focusTrendChart: "专注趋势图表",
    showFocusTimeChart: "显示专注时间",
    showTaskCountChart: "显示任务完成数量",
    focusTrend: "专注趋势",
    chartDownload: "下载",
    chartError: "绘制图表失败",
    noData: "暂无数据",
    noRecentFocus: "无专注记录",
    openChartError: "打开图表失败",
    focusTime: "专注时间",
    completedTasks: "完成任务",
    noItemSelected: "未选择显示项",
    
    // 其他
    focusItem: "专注事项（可选）",
    clickToInput: "点击输入时间",
    overtime: "已超时",
    totalFocusTime: "总时间",
    stopwatchOver10Hours: "正计时超过10小时，自动结束",
    csvHeaders: ["ID", "开始时间", "结束时间", "计划时长（秒）", "计划时长（分钟）", "实际时长（秒）", "实际时长（分钟）", "状态", "任务名称", "创建时间"],
    csvFilename: "专注记录",
    completedStatus: "完成",
    abandonedStatus: "放弃",
    exportData: "导出数据",
    exportDataDesc: "将专注记录数据导出为CSV格式文件",
    exportCSV: "导出CSV",
    exportSuccess: "数据导出成功！",
    exportFailed: "导出失败",
    noDataToExport: "没有数据可导出",
    deleteAllHistory: "删除所有历史记录",
    deleteAllHistoryDesc: "清空所有专注记录数据，此操作不可恢复。点击后需二次确认。",
    deleteAllHistoryConfirm: "确定要删除所有专注历史记录吗？此操作不可恢复。",
    deleteAllHistorySuccess: "已删除所有历史记录",
    deleteFailed: "删除失败",
    suggestTasks: "联想任务（每行一个）",
    suggestTasksDesc: "在专注事项输入时可联想的任务列表（最多100行）。每行限制：40个英文字符或10个其他字符。超过100行则无法继续输入。",
    suggestTasksPlaceholder: "写代码\n阅读\n运动",
    other: "其他",
    todayFocusAlt: "今天专注",
    yesterdayFocus: "昨天专注",
    dayFocus: "当天专注",
    todayCompletedAlt: "今天完成",
    yesterdayCompleted: "昨天完成",
    dayCompleted: "当天完成",
    dayBefore: "前一天",
    dayBeforeYesterday: "前天",
    noFocusRecordsToday: "当天没有专注记录",
    bothCannotBeNone: "错误：不能两个都为none",
    
    // 通知消息
    stopwatchStarted: "正计时开始",
    focusStarted: "专注开始：{minutes} 分钟",
    focusEnded: "专注结束：{status}（{minutes} 分钟）",
    restStarted: "休息开始：{minutes} 分钟",
    restEnded: "休息结束",
    focusStartFailed: "正在专注中，启动失败",
    focusStopFailed: "当前未在执行任务，放弃/完成任务失败",
    completeCountdownEarlyDisabled: "已关闭「倒计时允许提前完成」，无法提前完成"
  },
  en: {
    // Common
    cancel: "Cancel",
    delete: "Delete",
    confirm: "Confirm",
    close: "Close",
    start: "Start",
    complete: "Complete",
    abandon: "Abandon",
    download: "Download",
    
    // Status
    idle: "Idle",
    resting: "Resting",
    focusing: "Focusing",
    countdown: "Countdown",
    stopwatch: "Stopwatch",
    endRest: "End Rest",
    
    // Time units
    hour: "h",
    minute: "min",
    hourShort: "h ",
    minuteShort: "m",
    
    // Statistics
    todayFocus: "Today's Focus",
    todayCompleted: "Today Completed",
    monthlyAvgFocus: "Monthly Avg Focus",
    yearlyTotalFocus: "Yearly Total Focus",
    focusHistory: "Focus History",
    recentFocus: "Recent Focus",
    chart: "Chart",
    tasks: "tasks",
    yesterday: "Yesterday",
    lastMonth: "Last Month",
    avg7Days: "7-day Avg",
    monthlyAvg: "Monthly Avg",
    yearlyTotal: "Yearly Total",
    yearlyTotalCompleted: "Yearly Total Completed",
    oneTask: "a task",
    completed: "completed",
    abandoned: "abandoned",
    today: "Today",
    
    // Settings
    timerSettings: "Timer Settings",
    autoContinueAfterCountdown: "Auto Continue After Countdown",
    autoContinueDesc: "On: Countdown switches to stopwatch when finished. Off: Countdown auto-completes when finished.",
    statusBarShowFocus: "Show focus status in status bar",
    statusBarShowFocusDesc: "When on, the status bar shows current focus/rest timer; when off, it is hidden.",
    allowCompleteCountdownEarly: "Allow completing countdown early",
    allowCompleteCountdownEarlyDesc: "When off, only \"Abandon\" is shown during countdown and the Complete command cannot finish early.",
    keyboardShortcuts: "Keyboard Shortcuts",
    keyboardShortcutsDesc: "When enabled, with focus timer panel focused: Press Enter to start; Press Up to add time; Press Down to subtract time. Not triggered when typing in input fields.",
    defaultMode: "Default Mode",
    defaultModeDesc: "Select the default timer mode",
    defaultDurationMinutes: "Default Countdown Duration (minutes)",
    defaultDurationMinutesDesc: "Set the default countdown duration. Defaults to 25 minutes if empty. Only accepts positive integers.",
    adjustStepMinutes: "Adjust Step (minutes)",
    adjustStepMinutesDesc: "Set the minutes to add/subtract when clicking + / - buttons. Only accepts integers from 1-60.",
    autoRest: "Auto Rest After Timer",
    autoRestDesc: "When enabled, automatically starts rest after focus completes",
    defaultRestMinutes: "Default Rest Duration (minutes)",
    defaultRestMinutesDesc: "Applied when auto rest is enabled. Set the default rest duration. Defaults to 5 minutes if empty. Only accepts positive integers, max 600.",
    quickTimer: "Quick Timer",
    quickTimer1: "Quick Timer 1",
    quickTimer2: "Quick Timer 2",
    quickTimer3: "Quick Timer 3",
    quickTimerDesc: "Set the name and countdown duration (minutes) for the first quick timer. Max 40 ASCII characters.",
    quickTimerDesc2: "Set the name and countdown duration (minutes) for the second quick timer. Max 40 ASCII characters.",
    quickTimerDesc3: "Set the name and countdown duration (minutes) for the third quick timer. Max 40 ASCII characters.",
    timerName: "Timer Name",
    codeBlockChartSettings: "Focus Code Block Chart Default Settings",
    showFocusTime: "Show Focus Time (Code Block)",
    showFocusTimeDesc: "For line charts in focus code blocks: whether to show focus time by default",
    showTaskCount: "Show Task Completion Count (Code Block)",
    showTaskCountDesc: "For line charts in focus code blocks: whether to show task count by default",
    defaultChartRange: "Default Chart Range",
    defaultChartRangeDesc: "Select the default chart time range, need to refresh by editing the focus code block",
    days7: "7 Days",
    days14: "14 Days",
    days30: "30 Days",
    thisMonth: "This Month",
    thisYear: "This Year",
    
    // Chart
    focusTrendChart: "Focus Trend Chart",
    showFocusTimeChart: "Show Focus Time",
    showTaskCountChart: "Show Task Completion Count",
    focusTrend: "Focus Trend",
    chartDownload: "Download",
    chartError: "Failed to draw chart",
    noData: "No Data",
    noRecentFocus: "No data",
    openChartError: "Failed to open chart",
    focusTime: "Focus Time",
    completedTasks: "Completed Tasks",
    noItemSelected: "No item selected",
    
    // Other
    focusItem: "Focus Item (optional)",
    clickToInput: "Click to input time",
    overtime: "Overtime",
    totalFocusTime: "Total focus",
    stopwatchOver10Hours: "Stopwatch exceeded 10 hours, auto-completed",
    csvHeaders: ["ID", "Start Time", "End Time", "Planned Duration (seconds)", "Planned Duration (minutes)", "Actual Duration (seconds)", "Actual Duration (minutes)", "Status", "Task Name", "Created At"],
    csvFilename: "Focus Records",
    completedStatus: "Completed",
    abandonedStatus: "Abandoned",
    exportData: "Export Data",
    exportDataDesc: "Export focus records data as CSV file",
    exportCSV: "Export CSV",
    exportSuccess: "Data exported successfully!",
    exportFailed: "Export failed",
    noDataToExport: "No data to export",
    deleteAllHistory: "Delete All History",
    deleteAllHistoryDesc: "Clear all focus records data. This action cannot be undone. Requires confirmation.",
    deleteAllHistoryConfirm: "Are you sure you want to delete all focus history records? This action cannot be undone.",
    deleteAllHistorySuccess: "All history records deleted",
    deleteFailed: "Delete failed",
    suggestTasks: "Suggested Tasks (one per line)",
    suggestTasksDesc: "Task list for autocomplete when entering focus items (max 100 lines). Each line limit: 40 ASCII characters or 10 other characters. Cannot input more than 100 lines.",
    suggestTasksPlaceholder: "Coding\nReading\nExercise",
    other: "Other",
    todayFocusAlt: "Today's Focus",
    yesterdayFocus: "Yesterday's Focus",
    dayFocus: "Day's Focus",
    todayCompletedAlt: "Today Completed",
    yesterdayCompleted: "Yesterday Completed",
    dayCompleted: "Day Completed",
    dayBefore: "Previous Day",
    dayBeforeYesterday: "Previous Day",
    noFocusRecordsToday: "No focus records today",
    bothCannotBeNone: "Error: Both cannot be none",
    
    // Notification messages
    stopwatchStarted: "Stopwatch started",
    focusStarted: "Focus started: {minutes} minutes",
    focusEnded: "Focus ended: {status} ({minutes} minutes)",
    restStarted: "Rest started: {minutes} minutes",
    restEnded: "Rest ended",
    focusStartFailed: "You are focusing now, start failed",
    focusStopFailed: "You are not focusing now, nothing to abandon/complete",
    completeCountdownEarlyDisabled: "Early complete is disabled; cannot complete countdown early"
  }
};

// 全局语言缓存
let cachedLanguage = null;

// 检测用户语言：使用 Obsidian 的 moment.locale() 通过 pickLang 选择
const SUPPORTED_LANGS = ["en", "zh-cn", "ja"];
function getLanguage() {
  if (cachedLanguage !== null) return cachedLanguage;
  const loc = pickLang(SUPPORTED_LANGS, "en");
  // 与 translations 键对齐：zh-cn / zh-* 使用 "zh"
  cachedLanguage = (loc === "zh-cn" || loc.startsWith("zh")) ? "zh" : loc;
  return cachedLanguage;
}

// 翻译函数
function t(key, lang = null) {
  const currentLang = lang || getLanguage();
  return translations[currentLang]?.[key] || translations.en[key] || key;
}

// 获取当前语言
function getCurrentLanguage() {
  return getLanguage();
}

// 重置语言缓存（用于重新检测）
function resetLanguageCache() {
  cachedLanguage = null;
}
// ========== 国际化支持结束 ==========

// 通用确认对话框（使用 Obsidian Modal，而不是系统弹窗）
class ConfirmModal extends Modal {
  /**
   * @param {import('obsidian').App} app
   * @param {string} title
   * @param {string} message
   * @param {() => void | Promise<void>} onConfirm
   */
  constructor(app, title, message, onConfirm) {
    super(app);
    this.titleText = title;
    this.messageText = message;
    this.onConfirm = onConfirm;
  }

  onOpen() {
    const { contentEl, titleEl } = this;
    titleEl.setText(this.titleText);
    contentEl.empty();

    contentEl.createEl("p", { text: this.messageText, cls: "focus-confirm-message" });

    const buttons = contentEl.createDiv({ cls: "focus-confirm-buttons" });

    const cancelBtn = buttons.createEl("button", { text: t("cancel") });
    cancelBtn.onclick = () => this.close();

    const confirmBtn = buttons.createEl("button", { text: t("delete") });
    confirmBtn.addClass("mod-warning");
    confirmBtn.onclick = async () => {
      try {
        if (this.onConfirm) {
          await this.onConfirm();
        }
      } finally {
        this.close();
      }
    };
  }

  onClose() {
    this.contentEl.empty();
  }
}

// 判断字符是否为英文字符（ASCII字符）
function isAsciiChar(char) {
  return char.charCodeAt(0) <= 127;
}

// 计算字符数，区分英文字符和其他字符
function countChars(text) {
  let asciiCount = 0;
  let otherCount = 0;
  for (let i = 0; i < text.length; i++) {
    if (isAsciiChar(text[i])) {
      asciiCount++;
    } else {
      otherCount++;
    }
  }
  return { asciiCount, otherCount, total: text.length };
}

// 截断文本用于按钮显示（最多10个字符，超过用...代替）
function truncateForButton(text, maxLength = 10) {
  if (!text || text.length <= maxLength) {
    return text || "";
  }
  return text.substring(0, maxLength) + "...";
}

// 限制输入长度，区分英文字符和其他字符
// 英文字符（ASCII）最多40个，其他字符最多10个
function limitInputLength(text) {
  if (!text) return "";
  
  let asciiCount = 0;
  let otherCount = 0;
  let result = "";
  
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (isAsciiChar(char)) {
      if (asciiCount >= 40) {
        break; // 英文字符已达到上限
      }
      asciiCount++;
      result += char;
    } else {
      if (otherCount >= 10) {
        break; // 其他字符已达到上限
      }
      otherCount++;
      result += char;
    }
  }
  
  return result;
}

async function ensureJsonFile(app, path, fallbackObj) {
  const exists = await app.vault.adapter.exists(path);
  if (!exists) {
    await app.vault.adapter.write(path, JSON.stringify(fallbackObj, null, 2));
  }
}

async function readJson(app, path, fallbackObj) {
  try {
    const raw = await app.vault.adapter.read(path);
    return JSON.parse(raw);
  } catch (e) {
    return fallbackObj;
  }
}

async function writeJson(app, path, obj) {
  await app.vault.adapter.write(path, JSON.stringify(obj, null, 2));
}

// 读取整个 data.json 文件（文件缺失或解析失败时返回默认模板）
async function readDataFile(app) {
  return await readJson(app, DATA_PATH, getDefaultDataTemplate());
}

// 写入整个 data.json 文件（持锁写入，保证原子性）
async function writeDataFile(app, data) {
  await dataFileLock.runWithLock(async () => {
    await writeJson(app, DATA_PATH, data);
  });
}

// 读取 state
async function readState(app) {
  const data = await readDataFile(app);
  return data.state || { active: false, resting: false };
}

// 写入 state（合并更新，持锁读-改-写保证原子性）
async function writeState(app, state) {
  await dataFileLock.runWithLock(async () => {
    const data = await readDataFile(app);
    data.state = { ...data.state, ...state };
    await writeJson(app, DATA_PATH, data);
  });
}

// 读取 sessions
async function readSessions(app) {
  const data = await readDataFile(app);
  return Array.isArray(data.sessions) ? data.sessions : [];
}

// 写入 sessions（完全替换，持锁读-改-写保证原子性）
async function writeSessions(app, sessions) {
  await dataFileLock.runWithLock(async () => {
    const data = await readDataFile(app);
    data.sessions = sessions;
    await writeJson(app, DATA_PATH, data);
  });
}

// 读取 settings
async function readSettings(app) {
  const data = await readDataFile(app);
  return data.settings || {};
}

// 写入 settings（合并更新，持锁读-改-写保证原子性）
async function writeSettings(app, settings) {
  await dataFileLock.runWithLock(async () => {
    const data = await readDataFile(app);
    data.settings = { ...data.settings, ...settings };
    await writeJson(app, DATA_PATH, data);
  });
}

async function appendSession(app, session) {
  await ensureDataFileExists(app);
  await dataFileLock.runWithLock(async () => {
    const data = await readDataFile(app);
    data.sessions.push(session);
    await writeJson(app, DATA_PATH, data);
  });
}

function msBetween(aIso, bIso) {
  const a = new Date(aIso).getTime();
  const b = new Date(bIso).getTime();
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  return b - a;
}

function formatTime(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) {
    return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }
  // 10分钟以下显示为05:00格式（四位）
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function formatDate(isoString) {
  const date = new Date(isoString);
  const lang = getLanguage();
  const locale = lang === 'zh' ? 'zh-CN' : 'en-US';
  return date.toLocaleString(locale, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
}

function formatHours(seconds) {
  return (seconds / 3600).toFixed(1);
}

function formatTimeChinese(seconds) {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const lang = getLanguage();
  if (hours > 0) {
    return { number: `${hours}`, unit: lang === 'zh' ? " 时 " : "h ", number2: `${minutes}`, unit2: lang === 'zh' ? " 分" : "m" };
  }
  return { number: `${minutes}`, unit: lang === 'zh' ? " 分钟" : " min" };
}

function formatTimeShort(seconds) {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const lang = getLanguage();
  if (hours > 0) {
    return lang === 'zh' ? `${hours}时${minutes}分` : `${hours}h ${minutes}m`;
  }
  return lang === 'zh' ? `${minutes}分钟` : `${minutes} min`;
}

function getDateKey(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  // 使用本地时间生成日期键，避免时区问题
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

// 计算统计数据。规则：所有专注时长只统计 status==='completed' 的会话，放弃的不计入。
function calculateStats(sessions, baseDate = null) {
  // 如果指定了baseDate，使用该日期作为"今天"来计算
  // baseDate格式是 YYYY-MM-DD
  let now, today;
  if (baseDate) {
    // 解析baseDate为本地日期
    const [year, month, day] = baseDate.split('-').map(Number);
    now = new Date(year, month - 1, day);
    today = new Date(year, month - 1, day);
    today.setHours(0, 0, 0, 0);
  } else {
    now = new Date();
    today = new Date(now);
    today.setHours(0, 0, 0, 0);
  }
  
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  
  const sevenDaysAgo = new Date(today);
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
  
  const thirtyDaysAgo = new Date(today);
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
  
  const yearStart = new Date(now.getFullYear(), 0, 1);
  
  // 按日期分组（只统计已完成的专注时长，放弃的不计入）
  const byDate = {};
  sessions.forEach(s => {
    if (s.status !== "completed") return;
    const dateKey = getDateKey(s.start);
    if (!byDate[dateKey]) {
      byDate[dateKey] = 0;
    }
    byDate[dateKey] += s.actualSec || 0;
  });
  
  // 今天
  const todayKey = getDateKey(now);
  const todayTotal = byDate[todayKey] || 0;
  const todayCompleted = sessions.filter(s => {
    const sessionDate = getDateKey(new Date(s.start));
    return sessionDate === todayKey && s.status === "completed";
  }).length;
  
  // 昨天
  const yesterdayKey = getDateKey(yesterday);
  const yesterdayTotal = byDate[yesterdayKey] || 0;
  const yesterdayDiff = todayTotal - yesterdayTotal;
  const yesterdayCompleted = sessions.filter(s => {
    const sessionDate = getDateKey(new Date(s.start));
    return sessionDate === yesterdayKey && s.status === "completed";
  }).length;
  const yesterdayCompletedDiff = todayCompleted - yesterdayCompleted;
  
  // 近7天
  const last7Days = [];
  for (let i = 0; i < 7; i++) {
    const date = new Date(today);
    date.setDate(date.getDate() - i);
    const key = getDateKey(date);
    last7Days.push(byDate[key] || 0);
  }
  const avg7Days = last7Days.reduce((a, b) => a + b, 0) / 7;
  const avg7DaysDiff = todayTotal - avg7Days;
  
  // 移动平均（最近7天的平均值）
  const movingAvg = avg7Days;
  const movingAvgDiff = todayTotal - movingAvg;
  
  // 本月（当前自然月）
  const currentMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  currentMonthStart.setHours(0, 0, 0, 0);
  const currentMonthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0);
  currentMonthEnd.setHours(23, 59, 59, 999);
  // 本月自然月的总天数
  const currentMonthDays = currentMonthEnd.getDate();
  const currentMonthSessions = sessions.filter(s => {
    const sessionDate = new Date(s.start);
    return sessionDate >= currentMonthStart && sessionDate <= currentMonthEnd;
  });
  const currentMonthTotal = currentMonthSessions
    .filter(s => s.status === "completed")
    .reduce((sum, s) => sum + (s.actualSec || 0), 0);
  const avgCurrentMonth = currentMonthDays > 0 ? currentMonthTotal / currentMonthDays : 0;
  const currentMonthCompleted = currentMonthSessions.filter(s => s.status === "completed").length;
  const avgCurrentMonthCompleted = currentMonthDays > 0 ? currentMonthCompleted / currentMonthDays : 0;
  
  // 上月（上一个自然月）
  const lastMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  lastMonthStart.setHours(0, 0, 0, 0);
  const lastMonthEnd = new Date(now.getFullYear(), now.getMonth(), 0);
  lastMonthEnd.setHours(23, 59, 59, 999);
  const lastMonthDays = lastMonthEnd.getDate(); // 上月的总天数
  const lastMonthSessions = sessions.filter(s => {
    const sessionDate = new Date(s.start);
    return sessionDate >= lastMonthStart && sessionDate <= lastMonthEnd;
  });
  const lastMonthTotal = lastMonthSessions
    .filter(s => s.status === "completed")
    .reduce((sum, s) => sum + (s.actualSec || 0), 0);
  const avgLastMonth = lastMonthDays > 0 ? lastMonthTotal / lastMonthDays : 0;
  const lastMonthCompleted = lastMonthSessions.filter(s => s.status === "completed").length;
  const avgLastMonthCompleted = lastMonthDays > 0 ? lastMonthCompleted / lastMonthDays : 0;
  
  // 本月与上月的差值
  const monthDiff = avgCurrentMonth - avgLastMonth;
  const monthCompletedDiff = avgCurrentMonthCompleted - avgLastMonthCompleted;
  
  // 保留30天平均（用于其他计算）
  const last30Days = [];
  for (let i = 0; i < 30; i++) {
    const date = new Date(today);
    date.setDate(date.getDate() - i);
    const key = getDateKey(date);
    last30Days.push(byDate[key] || 0);
  }
  const avg30Days = last30Days.reduce((a, b) => a + b, 0) / 30;
  
  // 全年（只计已完成的专注时长）
  const yearSessions = sessions.filter(s => new Date(s.start) >= yearStart);
  const yearTotal = yearSessions
    .filter(s => s.status === "completed")
    .reduce((sum, s) => sum + (s.actualSec || 0), 0);
  const daysInYear = Math.floor((now - yearStart) / (1000 * 60 * 60 * 24)) + 1;
  const avgYear = yearTotal / daysInYear;
  
  // 近14天数据（用于折线图）
  const last14Days = [];
  for (let i = 13; i >= 0; i--) {
    const date = new Date(today);
    date.setDate(date.getDate() - i);
    const key = getDateKey(date);
    // 计算该日期的完成任务数
    const completedCount = sessions.filter(s => {
      const sessionDate = getDateKey(new Date(s.start));
      return sessionDate === key && s.status === "completed";
    }).length;
    last14Days.push({
      date: key,
      value: byDate[key] || 0,
      completed: completedCount
    });
  }
  
  // 计算7天平均完成任务数
  const last7DaysCompleted = [];
  for (let i = 0; i < 7; i++) {
    const date = new Date(today);
    date.setDate(date.getDate() - i);
    const key = getDateKey(date);
    const completed = sessions.filter(s => {
      const sessionDate = getDateKey(new Date(s.start));
      return sessionDate === key && s.status === "completed";
    }).length;
    last7DaysCompleted.push(completed);
  }
  const avg7DaysCompleted = last7DaysCompleted.reduce((a, b) => a + b, 0) / 7;
  
  // 保留30天平均完成任务数（用于其他计算）
  const last30DaysCompleted = [];
  for (let i = 0; i < 30; i++) {
    const date = new Date(today);
    date.setDate(date.getDate() - i);
    const key = getDateKey(date);
    const completed = sessions.filter(s => {
      const sessionDate = getDateKey(new Date(s.start));
      return sessionDate === key && s.status === "completed";
    }).length;
    last30DaysCompleted.push(completed);
  }
  const avg30DaysCompleted = last30DaysCompleted.reduce((a, b) => a + b, 0) / 30;
  
  // 计算全年完成任务数
  const yearCompleted = sessions.filter(s => {
    const sessionDate = new Date(s.start);
    return sessionDate >= yearStart && s.status === "completed";
  }).length;
  const avgYearCompleted = yearCompleted / daysInYear;
  
  return {
    today: todayTotal,
    todayCompleted,
    yesterdayDiff,
    yesterdayCompletedDiff,
    avg7Days,
    avg7DaysDiff,
    avg7DaysCompleted,
    movingAvg,
    movingAvgDiff,
    avg30Days,
    avg30DaysCompleted,
    avgCurrentMonth, // 本月平均
    avgCurrentMonthCompleted, // 本月平均完成任务数
    avgLastMonth, // 上月平均
    avgLastMonthCompleted, // 上月平均完成任务数
    monthDiff, // 本月与上月的差值
    monthCompletedDiff, // 本月与上月完成任务数的差值
    avgYear,
    yearTotal, // 全年总时长
    yearCompleted, // 全年完成任务总数
    avgYearCompleted,
    last14Days
  };
}

/** 图表范围统一配置：设置项可选值、内部短 key、计算用范围值、显示用翻译 key */
const CHART_RANGE_CONFIG = [
  { shortKey: "7", settingValues: ["7天", "7 Days"], labelKey: "days7", calcValue: "7天" },
  { shortKey: "14", settingValues: ["14天", "14 Days"], labelKey: "days14", calcValue: "14天" },
  { shortKey: "30", settingValues: ["30天", "30 Days"], labelKey: "days30", calcValue: "30天" },
  { shortKey: "month", settingValues: ["本月", "This Month"], labelKey: "thisMonth", calcValue: "本月" },
  { shortKey: "year", settingValues: ["今年", "This Year"], labelKey: "thisYear", calcValue: "今年" }
];
const DEFAULT_CHART_RANGE_SHORT = "14";

/** 将设置中的 defaultChartRange（可能为中文或英文）转为内部短 key */
function defaultChartRangeToShortKey(defaultRange) {
  if (!defaultRange) return DEFAULT_CHART_RANGE_SHORT;
  const found = CHART_RANGE_CONFIG.find(c => c.settingValues.includes(defaultRange));
  return found ? found.shortKey : DEFAULT_CHART_RANGE_SHORT;
}

/** 将内部短 key 转为 { rangeLabel, rangeForCalculation }，供图表标题与 calculateChartData 使用 */
function chartRangeToLabelAndCalculation(shortKey) {
  const found = CHART_RANGE_CONFIG.find(c => c.shortKey === shortKey);
  if (found) return { rangeLabel: t(found.labelKey), rangeForCalculation: found.calcValue };
  const fallback = CHART_RANGE_CONFIG.find(c => c.shortKey === DEFAULT_CHART_RANGE_SHORT);
  return { rangeLabel: t(fallback.labelKey), rangeForCalculation: fallback.calcValue };
}

// 计算不同时间范围的图表数据。规则：专注时长只统计 status==='completed'，放弃的不计入。
function calculateChartData(sessions, range) {
  const now = new Date();
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  
  // 按日期分组（专注时长只计已完成任务，放弃的不计入）
  const byDate = {};
  sessions.forEach(s => {
    const dateKey = getDateKey(s.start);
    if (!byDate[dateKey]) {
      byDate[dateKey] = { value: 0, completed: 0 };
    }
    if (s.status === "completed") {
      byDate[dateKey].value += s.actualSec || 0;
      byDate[dateKey].completed += 1;
    }
  });
  
  let data = [];
  
  if (range === "7天") {
    for (let i = 6; i >= 0; i--) {
      const date = new Date(today);
      date.setDate(date.getDate() - i);
      const key = getDateKey(date);
      data.push({
        date: key,
        value: byDate[key]?.value || 0,
        completed: byDate[key]?.completed || 0
      });
    }
  } else if (range === "14天") {
    for (let i = 13; i >= 0; i--) {
      const date = new Date(today);
      date.setDate(date.getDate() - i);
      const key = getDateKey(date);
      data.push({
        date: key,
        value: byDate[key]?.value || 0,
        completed: byDate[key]?.completed || 0
      });
    }
  } else if (range === "30天") {
    for (let i = 29; i >= 0; i--) {
      const date = new Date(today);
      date.setDate(date.getDate() - i);
      const key = getDateKey(date);
      data.push({
        date: key,
        value: byDate[key]?.value || 0,
        completed: byDate[key]?.completed || 0
      });
    }
  } else if (range === "本月") {
    const currentMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    currentMonthStart.setHours(0, 0, 0, 0);
    const currentMonthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0);
    currentMonthEnd.setHours(23, 59, 59, 999);
    const daysInMonth = currentMonthEnd.getDate();
    
    for (let i = 0; i < daysInMonth; i++) {
      const date = new Date(currentMonthStart);
      date.setDate(date.getDate() + i);
      const key = getDateKey(date);
      data.push({
        date: key,
        value: byDate[key]?.value || 0,
        completed: byDate[key]?.completed || 0
      });
    }
  } else if (range === "今年") {
    const yearStart = new Date(now.getFullYear(), 0, 1);
    yearStart.setHours(0, 0, 0, 0);
    const yearEnd = new Date(now.getFullYear(), 11, 31);
    yearEnd.setHours(23, 59, 59, 999);
    
    // 按周显示（每周一个数据点）
    let currentWeekStart = new Date(yearStart);
    // 找到第一个周一的日期
    const dayOfWeek = currentWeekStart.getDay();
    const daysToMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
    currentWeekStart.setDate(currentWeekStart.getDate() - daysToMonday);

    while (currentWeekStart <= yearEnd) {
      let weekEnd = new Date(currentWeekStart);
      weekEnd.setDate(weekEnd.getDate() + 6);
      
      let weekValue = 0;
      let weekCompleted = 0;
      // 使用新的日期对象进行循环，避免修改原始日期
      let d = new Date(currentWeekStart);
      const weekEndCopy = new Date(weekEnd);
      while (d <= weekEndCopy && d <= yearEnd) {
        const key = getDateKey(d);
        weekValue += byDate[key]?.value || 0;
        weekCompleted += byDate[key]?.completed || 0;
        // 创建新的日期对象，而不是修改现有的
        d = new Date(d);
        d.setDate(d.getDate() + 1);
      }
      
      data.push({
        date: getDateKey(currentWeekStart),
        value: weekValue,
        completed: weekCompleted
      });
      
      // 移动到下一周
      currentWeekStart.setDate(currentWeekStart.getDate() + 7);
    }
  }
  
  return data;
}

/**
 * 共享折线图绘制函数：专注趋势（时长 + 任务数）。
 * @param {HTMLElement} container - 挂载 canvas 的容器
 * @param {Array<{date:string, value:number, completed:number}>} data - 图表数据
 * @param {{ showTime?: boolean, showCount?: boolean, interactive?: boolean }} opts - showTime/showCount 控制显示；interactive 为 true 时显示 tooltip 并响应鼠标
 */
function createLineChart(container, data, opts = { showTime: true, showCount: true, interactive: true }) {
  if (!container || !(container instanceof Element || container instanceof HTMLElement)) return;
  if (!data || !Array.isArray(data) || data.length === 0) return;

  const existingCanvas = container.querySelector("canvas");
  if (existingCanvas) existingCanvas.remove();
  const existingTooltip = container.querySelector(".focus-chart-tooltip");
  if (existingTooltip) existingTooltip.remove();

  const interactive = opts.interactive !== false;
  const canvas = document.createElement("canvas");
  canvas.className = "focus-line-chart";
  const dpr = window.devicePixelRatio || 1;
  const width = 600;
  const height = 200;
  canvas.width = width * dpr;
  canvas.height = height * dpr;
  canvas.style.setProperty("--focus-canvas-width", width + "px");
  canvas.style.setProperty("--focus-canvas-height", height + "px");
  canvas.classList.add(interactive ? "focus-line-chart-interactive" : "focus-line-chart-static");
  container.appendChild(canvas);

  let tooltip = null;
  if (interactive) {
    tooltip = document.createElement("div");
    tooltip.className = "focus-chart-tooltip focus-chart-tooltip-hidden";
    container.appendChild(tooltip);
  }

  const ctx = canvas.getContext("2d");
  ctx.scale(dpr, dpr);
  const leftPadding = 40;
  const rightPadding = 70;
  const bottomPadding = 50;
  const topPadding = 20;
  const chartWidth = width - leftPadding - rightPadding;
  const chartHeight = height - topPadding - bottomPadding;

  const showTime = opts.showTime !== false;
  const showCount = opts.showCount !== false;
  const maxValue = Math.max(...data.map((d) => d.value || 0), 1);
  const maxHours = showTime ? (Math.ceil(maxValue / 3600) || 1) : 1;
  const maxCompleted = showCount ? Math.max(...data.map((d) => d.completed || 0), 1) : 1;
  const timePoints = [];
  const countPoints = [];

  function getAccentColor() {
    let accentColor = getComputedStyle(document.documentElement).getPropertyValue("--text-accent");
    if (accentColor) accentColor = accentColor.trim();
    if (!accentColor || accentColor === "") {
      accentColor = getComputedStyle(document.documentElement).getPropertyValue("--interactive-accent");
      if (accentColor) accentColor = accentColor.trim();
    }
    if (!accentColor || accentColor === "") {
      accentColor = getComputedStyle(document.documentElement).getPropertyValue("--accent");
      if (accentColor) accentColor = accentColor.trim();
    }
    if (!accentColor || accentColor === "") {
      try {
        const testEl = document.createElement("div");
        testEl.className = "focus-test-element";
        document.body.appendChild(testEl);
        const computedColor = getComputedStyle(testEl).color;
        document.body.removeChild(testEl);
        if (computedColor && computedColor !== "rgba(0, 0, 0, 0)" && computedColor !== "transparent") accentColor = computedColor;
      } catch (e) {}
    }
    if (!accentColor || accentColor === "") accentColor = "#008f32";
    return accentColor;
  }
  const countColor = "#ff9800";

  function drawChart() {
    ctx.clearRect(0, 0, width, height);
    if (!showTime && !showCount) {
      ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue("--text-muted") || "#999";
      ctx.font = "14px var(--font-text)";
      ctx.textAlign = "center";
      ctx.fillText(t("noItemSelected"), width / 2, height / 2);
      ctx.textAlign = "left";
      return;
    }
    ctx.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue("--background-modifier-border") || "#e0e0e0";
    ctx.lineWidth = 1;
    ctx.font = "11px var(--font-text)";
    ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue("--text-muted") || "#999";
    for (let i = 0; i <= 5; i++) {
      const y = topPadding + (chartHeight / 5) * i;
      if (showTime) {
        ctx.textAlign = "left";
        ctx.fillText((maxHours * (1 - i / 5)).toFixed(1) + "h", 5, y + 4);
      }
      if (showCount) {
        const valueC = Math.round(maxCompleted * (1 - i / 5));
        ctx.textAlign = "left";
        ctx.fillText((getLanguage() === "zh" ? valueC + "个" : valueC.toString()), width - rightPadding + 6, y + 4);
      }
      ctx.beginPath();
      ctx.moveTo(leftPadding, y);
      ctx.lineTo(width - rightPadding, y);
      ctx.stroke();
    }
    ctx.textAlign = "left";

    const accentColor = getAccentColor();
    timePoints.length = 0;
    if (showTime) {
      ctx.strokeStyle = accentColor;
      ctx.lineWidth = 2.5;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.beginPath();
      data.forEach((point, index) => {
        const x = leftPadding + (chartWidth / Math.max(1, data.length - 1)) * index;
        const y = topPadding + chartHeight - (point.value / 3600 / maxHours) * chartHeight;
        timePoints.push({ x, y, point, index });
        if (index === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.stroke();
      ctx.fillStyle = accentColor;
      timePoints.forEach(({ x, y }) => {
        ctx.beginPath();
        ctx.arc(x, y, 5, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = "#fff";
        ctx.beginPath();
        ctx.arc(x, y, 2.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = accentColor;
      });
    }
    countPoints.length = 0;
    if (showCount) {
      ctx.strokeStyle = countColor;
      ctx.lineWidth = 2.5;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.beginPath();
      data.forEach((point, index) => {
        const x = leftPadding + (chartWidth / Math.max(1, data.length - 1)) * index;
        const c = point.completed || 0;
        const y = topPadding + chartHeight - (c / maxCompleted) * chartHeight;
        countPoints.push({ x, y, point, index });
        if (index === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.stroke();
      ctx.fillStyle = countColor;
      countPoints.forEach(({ x, y }) => {
        ctx.beginPath();
        ctx.arc(x, y, 4, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = "#fff";
        ctx.beginPath();
        ctx.arc(x, y, 2, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = countColor;
      });
    }
    ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue("--text-muted") || "#999";
    ctx.font = "10px var(--font-text)";
    const xLabelStep = interactive ? 2 : 2;
    data.forEach((point, index) => {
      if (index % xLabelStep === 0 || (!interactive && index === data.length - 1)) {
        const x = leftPadding + (chartWidth / Math.max(1, data.length - 1)) * index;
        const date = new Date(point.date);
        ctx.save();
        ctx.translate(x, height - bottomPadding + 15);
        ctx.rotate(-Math.PI / 4);
        ctx.fillText(`${date.getMonth() + 1}/${date.getDate()}`, 0, 0);
        ctx.restore();
      }
    });
  }
  drawChart();

  if (interactive && tooltip) {
    canvas.addEventListener("mousemove", (e) => {
      const rect = canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      let nearestPoint = null;
      let minDistance = Infinity;
      [...timePoints, ...countPoints].forEach(({ x: px, y: py, point }) => {
        const distance = Math.sqrt((x - px) ** 2 + (y - py) ** 2);
        if (distance < 15 && distance < minDistance) {
          minDistance = distance;
          nearestPoint = { x: px, y: py, point };
        }
      });
      if (nearestPoint) {
        tooltip.classList.remove("focus-chart-tooltip-right");
        const date = new Date(nearestPoint.point.date);
        const lang = getLanguage();
        const dateStr = lang === "zh" ? `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日` : `${date.getMonth() + 1}/${date.getDate()}/${date.getFullYear()}`;
        const hours = Math.floor(nearestPoint.point.value / 3600);
        const minutes = Math.floor((nearestPoint.point.value % 3600) / 60);
        const timeStr = lang === "zh" ? (hours > 0 ? `${hours}时${minutes}分` : `${minutes}分`) : (hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`);
        const completedCount = nearestPoint.point.completed || 0;
        while (tooltip.firstChild) tooltip.removeChild(tooltip.firstChild);
        const titleDiv = document.createElement("div");
        titleDiv.className = "focus-chart-tooltip-title";
        titleDiv.textContent = dateStr;
        tooltip.appendChild(titleDiv);
        if (showTime) {
          const timeDiv = document.createElement("div");
          timeDiv.className = "focus-chart-tooltip-line";
          timeDiv.textContent = `${t("focusTime")}: ${timeStr}`;
          tooltip.appendChild(timeDiv);
        }
        if (showCount) {
          const countDiv = document.createElement("div");
          countDiv.className = "focus-chart-tooltip-line";
          countDiv.textContent = `${t("completedTasks")}: ${completedCount}${lang === "zh" ? "个" : ""}`;
          tooltip.appendChild(countDiv);
        }
        tooltip.classList.remove("focus-chart-tooltip-hidden");
        tooltip.classList.add("focus-chart-tooltip-measuring");
        const tooltipRect = tooltip.getBoundingClientRect();
        tooltip.classList.remove("focus-chart-tooltip-measuring");
        let tooltipX = nearestPoint.x;
        let tooltipY = nearestPoint.y - tooltipRect.height - 15;
        if (tooltipY < 0) tooltipY = nearestPoint.y + 20;
        const tooltipHalfWidth = tooltipRect.width / 2;
        tooltipX = Math.max(tooltipHalfWidth, Math.min(width - tooltipHalfWidth, tooltipX));
        if (tooltipX + tooltipHalfWidth > width - 5) tooltipX = Math.max(tooltipHalfWidth, width - tooltipHalfWidth - 5);
        if (tooltipX - tooltipHalfWidth < 5) tooltipX = Math.min(width - tooltipHalfWidth, tooltipHalfWidth + 5);
        tooltip.style.setProperty("--focus-tooltip-left", tooltipX + "px");
        tooltip.style.setProperty("--focus-tooltip-top", tooltipY + "px");
        tooltip.classList.add("focus-chart-tooltip-centered");
      } else {
        tooltip.classList.add("focus-chart-tooltip-hidden");
        tooltip.classList.remove("focus-chart-tooltip-right", "focus-chart-tooltip-centered");
      }
    });
    canvas.addEventListener("mouseleave", () => {
      tooltip.classList.add("focus-chart-tooltip-hidden");
      tooltip.classList.remove("focus-chart-tooltip-centered");
    });
  }
}

// 侧边栏视图
class FocusTimerView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.timerElements = null; // 保存计时器相关DOM元素的引用
    this._viewTimerId = "view-display-" + (leaf.id ?? "view-" + Date.now());
    this._resizeTimerId = "view-resize-" + (leaf.id ?? "view-" + Date.now());
    this.startTime = null; // 本地记录的开始时间
    this.plannedSec = null; // 计划时长
    this.timerMode = "countdown"; // 计时模式：countdown 或 stopwatch
    this.noteInput = null; // 保存输入框引用
    this.currentView = "stats"; // 当前视图："stats" 或 "history"
    this.restStartTime = null; // 休息开始时间
    this.restSec = null; // 休息时长（秒）
  }

  getViewType() {
    return VIEW_TYPE;
  }

  getDisplayText() {
    return getLanguage() === 'zh' ? "专注计时器" : "Focus Timer";
  }

  getIcon() {
    return "timer";
  }

  async onOpen() {
    await this.render();
    this.startTimer(); // 启动计时器更新
    
    // 监听容器高度和宽度变化，动态显示/隐藏内容和调整布局
    const container = this.containerEl.children[1];
    let lastHeight = container.clientHeight || this.containerEl.clientHeight || 400;
    let lastWidth = container.clientWidth || container.offsetWidth || this.containerEl.clientWidth || 400;
    
    if (container && window.ResizeObserver) {
      this.resizeObserver = new ResizeObserver(() => {
        // 防抖处理（使用统一定时器管理器）
        const mgr = this.plugin.timerManager;
        mgr.clear(this._resizeTimerId);
        mgr.setTimeout(this._resizeTimerId, 100, () => {
          const currentHeight = container.clientHeight || this.containerEl.clientHeight;
          const currentWidth = container.clientWidth || container.offsetWidth || this.containerEl.clientWidth;
          // 当高度跨越400px阈值或宽度跨越400px阈值时重新渲染
          const heightChanged = (lastHeight < 400 && currentHeight >= 400) || (lastHeight >= 400 && currentHeight < 400);
          const widthChanged = (lastWidth < 400 && currentWidth >= 400) || (lastWidth >= 400 && currentWidth < 400);
          if (heightChanged || widthChanged) {
            lastHeight = currentHeight;
            lastWidth = currentWidth;
            this.render(); // 重新渲染以显示/隐藏内容和调整布局
          } else {
            lastHeight = currentHeight;
            lastWidth = currentWidth;
          }
        });
      });
      this.resizeObserver.observe(container);
      // 也观察父容器
      if (this.containerEl) {
        this.resizeObserver.observe(this.containerEl);
      }
    }
  }

  startTimer() {
    this._wasOvertime = false; // 用于进入超时状态时只刷新一次面板
    const mgr = this.plugin.timerManager;
    mgr.clear(this._viewTimerId);
    mgr.setInterval(this._viewTimerId, 1000, () => this.updateTimerDisplay());
    this.updateTimerDisplay();
  }

  stopTimer() {
    this.plugin.timerManager.clear(this._viewTimerId);
  }

  updateTimerDisplay() {
    if (!this.timerElements) return;
    
    const { timeEl, circleEl, overtimeLabel } = this.timerElements;
    if (!timeEl) return;
    
    // 从本地时间计算，不读取文件
    // 优先检查休息状态
    if (this.restStartTime !== null && this.restSec !== null) {
      // 休息倒计时模式
      const now = Date.now();
      const elapsed = Math.floor((now - this.restStartTime) / 1000);
      const remaining = Math.max(0, this.restSec - elapsed);
      
      if (remaining === 0) {
        // 休息时间到，自动结束休息
        this.restStartTime = null;
        this.restSec = null;
        this.stopTimer();
        this.plugin.stopRest();
        return;
      }
      
      timeEl.textContent = formatTime(remaining);
      
        // 更新圆环进度
        if (circleEl) {
          const remainingRatio = this.restSec > 0 ? Math.min(1, remaining / this.restSec) : 0;
          const circumference = 2 * Math.PI * 45;
          const offset = circumference * (1 - remainingRatio);
          circleEl.style.setProperty('--focus-circle-offset', offset);
        }
    } else if (this.startTime !== null) {
      const now = Date.now();
      const elapsed = Math.floor((now - this.startTime) / 1000);
      
      if (this.timerMode === "stopwatch") {
        // 正计时模式：检查是否达到600分钟（10小时）
        const elapsedMinutes = elapsed / 60;
        if (elapsedMinutes >= 600) {
          // 达到600分钟，自动完成
          this.startTime = null;
          this.stopTimer();
          new Notice(t("stopwatchOver10Hours"), 5000);
          this.plugin.stopFocus("completed");
          return;
        }
        timeEl.textContent = formatTime(elapsed);
      } else if (this.plannedSec !== null) {
        // 倒计时模式
        const remaining = Math.max(0, this.plannedSec - elapsed);
        const isOvertime = remaining === 0 && this.plannedSec > 0;
        
        if (isOvertime && this.plugin.settings.autoContinue) {
          // 进入超时状态时刷新面板一次，以便「完成」按钮显示出来
          if (!this._wasOvertime) {
            this._wasOvertime = true;
            this.render();
            return;
          }
          // 超时后自动继续计时，主数字上写清楚「超时」/「Overtime」；底部红字为总时间
          const overtimeSec = elapsed - this.plannedSec;
          timeEl.textContent = t("overtime") + " " + formatTime(overtimeSec);
          if (overtimeLabel) {
            overtimeLabel.textContent = t("totalFocusTime") + " " + formatTime(elapsed);
          }
        } else if (isOvertime) {
          // 开关关闭时：倒计时结束时自动完成
          this.startTime = null;
          this.stopTimer();
          this.plugin.stopFocus("completed");
          return;
        } else {
          // 正常倒计时
          timeEl.textContent = formatTime(remaining);
        }
        
        // 更新圆环进度（仅在未超时时）
        if (circleEl && !isOvertime) {
          const remainingRatio = this.plannedSec > 0 ? Math.min(1, remaining / this.plannedSec) : 0;
          const circumference = 2 * Math.PI * 45; // 半径45
          const offset = circumference * (1 - remainingRatio);
          circleEl.style.setProperty('--focus-circle-offset', offset);
        }
      }
    }
  }

  async onClose() {
    this.stopTimer();
    this.plugin.timerManager.clear(this._resizeTimerId);
    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
      this.resizeObserver = null;
    }
    if (this._autocompleteClickOutsideHandler) {
      document.removeEventListener("click", this._autocompleteClickOutsideHandler);
      this._autocompleteClickOutsideHandler = null;
    }
  }

  handleKeyboardEnter() {
    if (!this._idle) return;
    let note = (this.noteInput && this.noteInput.value) ? this.noteInput.value.trim() : "";
    note = limitInputLength(note);
    if (this._isStopwatch) {
      this.plugin.startFocus(null, "stopwatch", note);
    } else {
      if (this.timeEditorOpen && this.editingTimeDigits) {
        const hh = parseInt(this.editingTimeDigits.slice(0, 2), 10) || 0;
        const mm = parseInt(this.editingTimeDigits.slice(2, 4), 10) || 0;
        let totalMinutes = hh * 60 + mm;
        totalMinutes = Math.max(1, Math.min(600, totalMinutes));
        this.defaultDuration = totalMinutes * 60;
        if (this._timeEditorClose) this._timeEditorClose(false);
      }
      this.plugin.startFocus(this.defaultDuration, "countdown", note);
    }
    if (this.noteInput) this.noteInput.value = "";
  }

  handleKeyboardArrowUp() {
    if (!this._idle || this._isStopwatch) return;
    const stepSec = (this.plugin.settings.adjustStepMinutes || 5) * 60;
    this.defaultDuration = Math.min(this.defaultDuration + stepSec, 600 * 60);
    if (this.defaultTimeEl) this.defaultTimeEl.textContent = formatTime(this.defaultDuration);
  }

  handleKeyboardArrowDown() {
    if (!this._idle || this._isStopwatch) return;
    const stepSec = (this.plugin.settings.adjustStepMinutes || 5) * 60;
    this.defaultDuration = Math.max(this.defaultDuration - stepSec, 1 * 60);
    if (this.defaultTimeEl) this.defaultTimeEl.textContent = formatTime(this.defaultDuration);
  }

  async render() {
    const container = this.containerEl.children[1];
    // 保存输入框的值（如果存在）
    const savedNoteValue = this.noteInput ? this.noteInput.value : "";
    container.empty();
    this.timerElements = null; // 重置引用
    this.noteInput = null; // 重置输入框引用

    // 检测容器高度和宽度
    // 等待一帧确保容器已渲染
    await new Promise(resolve => requestAnimationFrame(resolve));
    const containerHeight = container.clientHeight || container.offsetHeight || this.containerEl.clientHeight || 400;
    const containerWidth = container.clientWidth || container.offsetWidth || this.containerEl.clientWidth || 400;
    const isCompact = containerHeight < 400;
    const isNarrow = containerWidth < 400; // 宽度较窄时使用单列布局

    const state = await readState(this.plugin.app);
    this._idle = !state.active && !state.resting;
    const sessions = await readSessions(this.plugin.app);
    
    // 统计只使用已持久化的会话，专注进行中时不把当前时长计入统计；完成时由 stopFocus 写入后再反映到统计中
    const sessionsForStats = sessions;
    
    // 计算统计数据
    const stats = calculateStats(sessionsForStats);

    // 顶部：圆环倒计时区域
    const timerSection = container.createDiv("focus-timer-section");
    
    // 状态文字和呼吸灯容器（放在圆环上方，作为独立块）
    const statusContainer = timerSection.createDiv("focus-status-container");
    
    // 呼吸灯（只在专注或休息时呼吸）
    const breathingLight = statusContainer.createDiv("focus-breathing-light");
    if (state.resting) {
      breathingLight.classList.add("focus-breathing-rest");
    } else if (state.active) {
      breathingLight.classList.add("focus-breathing-active");
    } else {
      breathingLight.classList.add("focus-breathing-idle");
      // 空闲时不呼吸，只显示静态颜色
    }
    
    // 状态文字和快捷按钮容器
    const statusTextContainer = statusContainer.createDiv("focus-status-text-container");
    
    const statusText = statusTextContainer.createEl("div", { cls: "focus-status-text" });
    
    // 检查休息状态
    if (state.resting) {
      // 休息状态
      statusText.textContent = t("resting");
      breathingLight.classList.remove("focus-breathing-active", "focus-breathing-idle");
      breathingLight.classList.add("focus-breathing-rest");
    } else if (state.active) {
      const mode = state.mode || "countdown";
      const modeText = mode === "stopwatch" ? t("stopwatch") : t("countdown");
      // 如果有专注事项，显示"任务名称-倒计时/正计时"
      if (state.note && state.note.trim()) {
        statusText.textContent = `${state.note.trim()}-${modeText}`;
      } else {
        statusText.textContent = `${t("focusing")}-${modeText}`;
      }
    } else {
      statusText.textContent = t("idle");
      
      // 在空闲状态下，添加三个快捷Timer按钮
      const quickTimers = [
        this.plugin.settings.quickTimer1,
        this.plugin.settings.quickTimer2,
        this.plugin.settings.quickTimer3
      ];
      
      quickTimers.forEach((timer, index) => {
        if (timer && timer.name && timer.name.trim()) {
          const timerName = timer.name.trim();
          const displayName = truncateForButton(timerName, 15);
          const quickBtn = statusTextContainer.createEl("button", {
            text: displayName,
            cls: "focus-quick-timer-btn"
          });
          // 添加title属性，鼠标悬停时显示完整名称
          if (timerName.length > 15) {
            quickBtn.setAttribute("title", timerName);
          }
          quickBtn.onclick = () => {
            const minutes = timer.minutes || 25;
            this.plugin.startFocus(minutes * 60, "countdown", timerName);
          };
        }
      });
    }
    
    const circleContainer = timerSection.createDiv("focus-circle-container");
    
    // 初始化休息相关变量
    this.restStartTime = null;
    this.restSec = null;
    
    if (state.resting) {
      // 休息状态
      const restStartTime = new Date(state.restStart).getTime();
      const restSec = state.restSec || 300; // 默认5分钟
      this.restStartTime = restStartTime;
      this.restSec = restSec;
      
      // 圆环SVG（休息倒计时）
      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.setAttribute("class", "focus-circle-svg");
      svg.setAttribute("viewBox", "0 0 100 100");
      
      const bgCircle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
      bgCircle.setAttribute("cx", "50");
      bgCircle.setAttribute("cy", "50");
      bgCircle.setAttribute("r", "45");
      bgCircle.setAttribute("fill", "none");
      bgCircle.setAttribute("stroke", "var(--background-modifier-border)");
      bgCircle.setAttribute("stroke-width", "8");
      svg.appendChild(bgCircle);
      
      const progressCircle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
      progressCircle.setAttribute("cx", "50");
      progressCircle.setAttribute("cy", "50");
      progressCircle.setAttribute("r", "45");
      progressCircle.setAttribute("fill", "none");
      progressCircle.setAttribute("stroke", "var(--text-accent)");
      progressCircle.setAttribute("stroke-width", "8");
      progressCircle.setAttribute("stroke-linecap", "round");
      progressCircle.setAttribute("stroke-dasharray", "283");
      progressCircle.setAttribute("transform", "rotate(-90 50 50)");
      progressCircle.setAttribute("class", "focus-progress-circle");
      svg.appendChild(progressCircle);
      
      circleContainer.appendChild(svg);
      this.timerElements = {};
      this.timerElements.circleEl = progressCircle;
      
      // 时间显示
      const timeDisplay = circleContainer.createDiv("focus-time-display");
      const now = Date.now();
      const elapsed = Math.floor((now - restStartTime) / 1000);
      const remaining = Math.max(0, restSec - elapsed);
      const timeEl = timeDisplay.createEl("div", {
        text: formatTime(remaining),
        cls: "focus-elapsed-time"
      });
      this.timerElements.timeEl = timeEl;
      
      // 按钮：结束休息
      const btnContainer = timerSection.createDiv("focus-btn-container");
      const endRestBtn = btnContainer.createEl("button", { text: t("endRest"), cls: "focus-btn-primary" });
      endRestBtn.onclick = () => this.plugin.stopRest();
    } else if (state.active) {
      // 保存开始时间和计划时长，用于本地计时
      this.startTime = new Date(state.start).getTime();
      this.plannedSec = state.plannedSec;
      this.timerMode = state.mode || "countdown";
      const isStopwatch = this.timerMode === "stopwatch";
      
      const now = Date.now();
      const elapsed = Math.floor((now - this.startTime) / 1000);
      
      // 判断是否超时
      let isOvertime = false;
      let overtimeSec = 0;
      let remaining = 0;
      let remainingRatio = 1;
      
      if (isStopwatch) {
        // 正计时模式：只显示已用时间
        remaining = elapsed;
      } else {
        // 倒计时模式
        remaining = Math.max(0, this.plannedSec - elapsed);
        remainingRatio = this.plannedSec > 0 ? Math.min(1, remaining / this.plannedSec) : 0;
        
        // 检查是否超时
        if (remaining === 0 && this.plannedSec > 0) {
          isOvertime = true;
          overtimeSec = elapsed - this.plannedSec;
          // 如果设置了自动继续，则继续计时
          if (this.plugin.settings.autoContinue) {
            // 超时后自动转为正计时
          }
        }
      }
      
      // 只在倒计时模式且未超时时显示圆环
      if (!isStopwatch && !isOvertime) {
        // 圆环SVG
        const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        svg.setAttribute("class", "focus-circle-svg");
        svg.setAttribute("viewBox", "0 0 100 100");
        
        // 背景圆环（浅色，表示已用时间）
        const bgCircle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
        bgCircle.setAttribute("cx", "50");
        bgCircle.setAttribute("cy", "50");
        bgCircle.setAttribute("r", "45");
        bgCircle.setAttribute("fill", "none");
        bgCircle.setAttribute("stroke", "var(--background-modifier-border)");
        bgCircle.setAttribute("stroke-width", "8");
        svg.appendChild(bgCircle);
        
        // 剩余时间圆环（深色，从上方开始，表示剩余比例）
        const progressCircle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
        progressCircle.setAttribute("cx", "50");
        progressCircle.setAttribute("cy", "50");
        progressCircle.setAttribute("r", "45");
        progressCircle.setAttribute("fill", "none");
        progressCircle.setAttribute("stroke", "var(--text-accent)");
        progressCircle.setAttribute("stroke-width", "8");
        progressCircle.setAttribute("stroke-linecap", "round");
        progressCircle.setAttribute("stroke-dasharray", "283");
        progressCircle.setAttribute("stroke-dashoffset", 283 * (1 - remainingRatio));
        progressCircle.setAttribute("transform", "rotate(-90 50 50)");
        progressCircle.setAttribute("class", "focus-progress-circle");
        svg.appendChild(progressCircle);
        
        circleContainer.appendChild(svg);
        this.timerElements = {};
        this.timerElements.circleEl = progressCircle;  // 保存圆环引用
      } else {
        // 正计时模式或超时：不显示圆环，只显示时间
        this.timerElements = {};
      }
      
      // 时间显示
      const timeDisplay = circleContainer.createDiv("focus-time-display");
      let timeText = "";
      if (isStopwatch) {
        timeText = formatTime(elapsed);
      } else if (isOvertime) {
        // 超时时：主数字上写清楚「超时」/「Overtime」；若未开自动继续则显示00:00
        if (this.plugin.settings.autoContinue) {
          timeText = t("overtime") + " " + formatTime(overtimeSec);
        } else {
          timeText = "00:00";
        }
      } else {
        timeText = formatTime(remaining);
      }
      
      const timeEl = timeDisplay.createEl("div", { 
        text: timeText,
        cls: "focus-elapsed-time"
      });
      
      // 超时时底部红字：总时间（倒计时 + 超时）
      if (isOvertime) {
        const overtimeLabel = timeDisplay.createEl("div", {
          text: `${t("totalFocusTime")} ${formatTime(elapsed)}`,
          cls: "focus-overtime-label"
        });
        this.timerElements.overtimeLabel = overtimeLabel;
      }
      
      this.timerElements.timeEl = timeEl;
      
      // 按钮：完成、放弃（关闭「倒计时允许提前完成」时倒计时只显示放弃；超时后一律显示完成）
      const btnContainer = timerSection.createDiv("focus-btn-container");
      const allowEarly = this.plugin.settings.allowCompleteCountdownEarly !== false;
      const isCountdown = this.timerMode === "countdown";
      const showComplete = allowEarly || !isCountdown || isOvertime;
      if (showComplete) {
        const completeBtn = btnContainer.createEl("button", { text: t("complete"), cls: "focus-btn-primary" });
        completeBtn.onclick = () => this.plugin.stopFocus("completed");
      }
      const abandonBtn = btnContainer.createEl("button", { text: t("abandon"), cls: "focus-btn-secondary" });
      abandonBtn.onclick = () => this.plugin.stopFocus("abandoned");
    } else {
      // 非专注状态
      this.startTime = null;
      this.plannedSec = null;
      this.timerMode = this.plugin.settings.defaultMode || "countdown";
      // 使用设置中的默认倒计时时间，如果没有设置则使用25分钟
      const defaultMinutes = this.plugin.settings.defaultDurationMinutes || 25;
      this.defaultDuration = defaultMinutes * 60;
      
      const isStopwatch = this.timerMode === "stopwatch";
      this._isStopwatch = isStopwatch;
      
      // 只在倒计时模式显示圆环
      if (!isStopwatch) {
        // 圆环SVG（空圆环）
        const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        svg.setAttribute("class", "focus-circle-svg");
        svg.setAttribute("viewBox", "0 0 100 100");
        
        const bgCircle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
        bgCircle.setAttribute("cx", "50");
        bgCircle.setAttribute("cy", "50");
        bgCircle.setAttribute("r", "45");
        bgCircle.setAttribute("fill", "none");
        bgCircle.setAttribute("stroke", "var(--background-modifier-border)");
        bgCircle.setAttribute("stroke-width", "8");
        svg.appendChild(bgCircle);
        circleContainer.appendChild(svg);
      }
      
      // 时间显示
      const timeDisplay = circleContainer.createDiv("focus-time-display");
      if (isStopwatch) {
        const stopwatchLabel = timeDisplay.createEl("div", {
          text: "00:00",
          cls: "focus-elapsed-time"
        });
        this.defaultTimeEl = stopwatchLabel;
      } else {
        const timeWrapper = timeDisplay.createDiv("focus-time-wrapper");
        const defaultTimeEl = timeWrapper.createEl("div", { 
          text: formatTime(this.defaultDuration),
          cls: "focus-elapsed-time focus-time-clickable"
        });
        defaultTimeEl.setAttribute("title", t("clickToInput"));
        this.defaultTimeEl = defaultTimeEl;

        const editorContainer = timeWrapper.createDiv("focus-time-editor focus-time-editor-hidden");
        const editBoxes = editorContainer.createDiv("focus-time-edit-boxes");
        const hoursInput = editBoxes.createEl("input", { type: "text", cls: "focus-time-box focus-time-box-input" });
        hoursInput.maxLength = 2;
        hoursInput.setAttribute("inputmode", "numeric");
        hoursInput.setAttribute("placeholder", "00");
        editBoxes.appendText(" h ");
        const minutesInput = editBoxes.createEl("input", { type: "text", cls: "focus-time-box focus-time-box-input" });
        minutesInput.maxLength = 2;
        minutesInput.setAttribute("inputmode", "numeric");
        minutesInput.setAttribute("placeholder", "00");
        editBoxes.appendText(" m ");

        let timeDigits = "0000";
        const syncInputsFromDigits = () => {
          hoursInput.value = timeDigits.slice(0, 2);
          minutesInput.value = timeDigits.slice(2, 4);
        };

        const openEditor = () => {
          timeDigits = "0000";
          defaultTimeEl.classList.add("focus-time-display-hidden");
          editorContainer.classList.remove("focus-time-editor-hidden");
          syncInputsFromDigits();
          this.timeEditorOpen = true;
          this.editingTimeDigits = timeDigits;
          this._timeEditorClose = (apply) => {
            if (apply) {
              const hh = parseInt(timeDigits.slice(0, 2), 10) || 0;
              const mm = parseInt(timeDigits.slice(2, 4), 10) || 0;
              let totalMinutes = hh * 60 + mm;
              totalMinutes = Math.max(1, Math.min(600, totalMinutes));
              this.defaultDuration = totalMinutes * 60;
              defaultTimeEl.textContent = formatTime(this.defaultDuration);
            }
            editorContainer.classList.add("focus-time-editor-hidden");
            defaultTimeEl.classList.remove("focus-time-display-hidden");
            this.timeEditorOpen = false;
            if (this._timeEditorClickOutside) {
              document.removeEventListener("click", this._timeEditorClickOutside);
              this._timeEditorClickOutside = null;
            }
          };
          const closeEditor = this._timeEditorClose;
          this._timeEditorClickOutside = (e) => {
            if (!editorContainer.contains(e.target) && !defaultTimeEl.contains(e.target)) {
              closeEditor(true);
            }
          };
          document.addEventListener("click", this._timeEditorClickOutside);
          minutesInput.focus();
        };

        hoursInput.addEventListener("keydown", (e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            this._timeEditorClose(true);
            return;
          }
          if (e.key === "Escape") {
            e.preventDefault();
            this._timeEditorClose(false);
            return;
          }
          if (e.key >= "0" && e.key <= "9") {
            e.preventDefault();
            timeDigits = (timeDigits.slice(0, 2) + e.key).slice(-2) + timeDigits.slice(2, 4);
            syncInputsFromDigits();
            this.editingTimeDigits = timeDigits;
            return;
          }
          if (e.key === "Backspace") {
            e.preventDefault();
            const hh = ("0" + timeDigits.slice(0, 2).slice(0, -1)).slice(-2);
            timeDigits = hh + timeDigits.slice(2, 4);
            syncInputsFromDigits();
            this.editingTimeDigits = timeDigits;
          }
        });

        minutesInput.addEventListener("keydown", (e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            this._timeEditorClose(true);
            return;
          }
          if (e.key === "Escape") {
            e.preventDefault();
            this._timeEditorClose(false);
            return;
          }
          if (e.key >= "0" && e.key <= "9") {
            e.preventDefault();
            timeDigits = (timeDigits + e.key).slice(-4);
            syncInputsFromDigits();
            this.editingTimeDigits = timeDigits;
            return;
          }
          if (e.key === "Backspace") {
            e.preventDefault();
            timeDigits = ("0" + timeDigits.slice(0, -1)).slice(-4);
            syncInputsFromDigits();
            this.editingTimeDigits = timeDigits;
          }
        });

        defaultTimeEl.addEventListener("click", openEditor);
      }
      
      // 专注事项输入框（带自动补全功能）
      const noteInputContainer = timerSection.createDiv("focus-note-input-container");
      const noteInput = noteInputContainer.createEl("input", {
        type: "text",
        placeholder: t("focusItem"),
        cls: "focus-note-input"
      });
      // 如果有保存的值，恢复它
      if (savedNoteValue) {
        noteInput.value = savedNoteValue;
      }
      this.noteInput = noteInput; // 保存引用
      
      // 创建自动补全下拉列表
      const autocompleteList = noteInputContainer.createDiv("focus-autocomplete-list focus-autocomplete-list-hidden");
      let selectedIndex = -1;
      let filteredSuggestions = [];
      
      // 联想任务列表：与设置共用 suggestTasks，顺序=优先级（首位为最近使用）
      const getSuggestNotes = () => {
        const list = this.plugin.settings.suggestTasks || [];
        return Array.isArray(list) ? [...list] : [];
      };
      
      // 更新下拉列表（仅从设置中的联想任务列表联想，与设置共用同一列表）
      const updateAutocomplete = (query) => {
        if (!query || query.trim() === "") {
          autocompleteList.classList.add("focus-autocomplete-list-hidden");
          selectedIndex = -1;
          return;
        }
        
        const list = getSuggestNotes();
        const lowerQuery = query.toLowerCase();
        filteredSuggestions = list.filter(note =>
          note.toLowerCase().includes(lowerQuery) && note !== query
        );
        
        if (filteredSuggestions.length === 0) {
          autocompleteList.classList.add("focus-autocomplete-list-hidden");
          selectedIndex = -1;
          return;
        }
        
        // 显示建议列表
        autocompleteList.empty();
        filteredSuggestions.slice(0, 5).forEach((suggestion, index) => {
          const item = autocompleteList.createDiv("focus-autocomplete-item");
          item.textContent = suggestion;
          if (index === selectedIndex) {
            item.classList.add("focus-autocomplete-item-selected");
          }
          item.onclick = () => {
            noteInput.value = suggestion;
            this.plugin.moveSuggestToFront(suggestion);
            autocompleteList.classList.add("focus-autocomplete-list-hidden");
            selectedIndex = -1;
            noteInput.focus();
          };
        });
        autocompleteList.classList.remove("focus-autocomplete-list-hidden");
      };
      
      // 输入事件监听
      noteInput.addEventListener("input", (e) => {
        // 限制专注事项：英文字符最多40个，其他字符最多10个
        const value = e.target.value;
        const limited = limitInputLength(value);
        if (value !== limited) {
          e.target.value = limited;
        }
        updateAutocomplete(e.target.value);
        selectedIndex = -1;
      });
      
      // 键盘事件监听
      noteInput.addEventListener("keydown", (e) => {
        if (autocompleteList.classList.contains("focus-autocomplete-list-hidden")) return;
        
        if (e.key === "ArrowDown") {
          e.preventDefault();
          selectedIndex = Math.min(selectedIndex + 1, filteredSuggestions.length - 1);
          updateAutocomplete(noteInput.value);
        } else if (e.key === "ArrowUp") {
          e.preventDefault();
          selectedIndex = Math.max(selectedIndex - 1, -1);
          updateAutocomplete(noteInput.value);
        } else if (e.key === "Enter" && selectedIndex >= 0 && selectedIndex < filteredSuggestions.length) {
          e.preventDefault();
          const chosen = filteredSuggestions[selectedIndex];
          noteInput.value = chosen;
          this.plugin.moveSuggestToFront(chosen);
          autocompleteList.classList.add("focus-autocomplete-list-hidden");
          selectedIndex = -1;
        } else if (e.key === "Escape") {
          autocompleteList.classList.add("focus-autocomplete-list-hidden");
          selectedIndex = -1;
        }
      });
      
      // 点击外部关闭下拉列表（先移除旧监听器，避免重复添加导致泄漏）
      if (this._autocompleteClickOutsideHandler) {
        document.removeEventListener("click", this._autocompleteClickOutsideHandler);
        this._autocompleteClickOutsideHandler = null;
      }
      this._autocompleteClickOutsideHandler = (e) => {
        if (!noteInputContainer.contains(e.target)) {
          autocompleteList.classList.add("focus-autocomplete-list-hidden");
          selectedIndex = -1;
        }
      };
      document.addEventListener("click", this._autocompleteClickOutsideHandler);
      
      // 按钮容器：模式切换按钮（在开始按钮左侧）+ 开始、加、减
      const btnContainer = timerSection.createDiv("focus-btn-container");
      
      // 模式切换按钮（胶囊样式，放在开始按钮左侧）
      const modeToggleBtn = btnContainer.createEl("button", {
        text: isStopwatch ? t("stopwatch") : t("countdown"),
        cls: "focus-mode-toggle-btn"
      });
      modeToggleBtn.onclick = async () => {
        const newMode = isStopwatch ? "countdown" : "stopwatch";
        this.plugin.settings.defaultMode = newMode;
        await this.plugin.saveSettings();
        this.render();
      };
      
      const startBtn = btnContainer.createEl("button", { text: t("start"), cls: "focus-btn-start" });
      startBtn.onclick = () => {
        // 限制专注事项：英文字符最多40个，其他字符最多10个
        let note = noteInput.value.trim() || "";
        const limitedNote = limitInputLength(note);
        if (note !== limitedNote) {
          note = limitedNote;
          noteInput.value = note;
        }
        if (isStopwatch) {
          this.plugin.startFocus(null, "stopwatch", note);
        } else {
          // 若正在编辑时间未锁定，按当前输入的时间开始（并做合法性校验）
          if (this.timeEditorOpen && this.editingTimeDigits) {
            const hh = parseInt(this.editingTimeDigits.slice(0, 2), 10) || 0;
            const mm = parseInt(this.editingTimeDigits.slice(2, 4), 10) || 0;
            let totalMinutes = hh * 60 + mm;
            totalMinutes = Math.max(1, Math.min(600, totalMinutes));
            this.defaultDuration = totalMinutes * 60;
            if (this._timeEditorClose) this._timeEditorClose(false);
          }
          this.plugin.startFocus(this.defaultDuration, "countdown", note);
        }
        // 开始后清空输入框
        noteInput.value = "";
      };
      
      if (!isStopwatch) {
        const addBtn = btnContainer.createEl("button", { text: "+", cls: "focus-btn-control" });
        addBtn.onclick = () => {
          const stepSec = (this.plugin.settings.adjustStepMinutes || 5) * 60;
          this.defaultDuration = Math.min(this.defaultDuration + stepSec, 600 * 60);
          if (this.defaultTimeEl) this.defaultTimeEl.textContent = formatTime(this.defaultDuration);
        };
        
        const minusBtn = btnContainer.createEl("button", { text: "-", cls: "focus-btn-control" });
        minusBtn.onclick = () => {
          const stepSec = (this.plugin.settings.adjustStepMinutes || 5) * 60;
          this.defaultDuration = Math.max(this.defaultDuration - stepSec, 1 * 60);
          if (this.defaultTimeEl) this.defaultTimeEl.textContent = formatTime(this.defaultDuration);
        };
      }
      
    }

    // 统计卡片区域和历史记录区域（仅在高度足够时显示）
    if (!isCompact) {
      // 切换视图的按钮容器
      const viewToggleContainer = container.createDiv("focus-view-toggle-container");
      const statsToggleBtn = viewToggleContainer.createEl("button", { 
        text: t("focusHistory"), 
        cls: "focus-view-toggle-btn" 
      });
      const historyToggleBtn = viewToggleContainer.createEl("button", { 
        text: t("recentFocus"), 
        cls: "focus-view-toggle-btn" 
      });
      // 图表按钮放在"最近专注"按钮的右侧
      const chartBtn = viewToggleContainer.createEl("button", { text: t("chart"), cls: "focus-chart-btn" });
      chartBtn.onclick = async () => {
        try {
          await this.showChart();
        } catch (error) {
          new Notice(`${t("openChartError")}: ${error.message}`, 5000);
        }
      };
      
      // 视图容器
      const viewContainer = container.createDiv("focus-view-container");
      
      // 统计卡片区域
      const statsSection = viewContainer.createDiv("focus-stats-section");
      if (this.currentView !== "stats") {
        statsSection.classList.add("focus-section-hidden");
      }
      const statsHeader = statsSection.createDiv("focus-stats-header");
    //   statsHeader.createEl("h3", { text: "专注记录", cls: "focus-stats-title" });
      
      // 统计卡片网格（根据宽度动态调整：窄时1列，宽时2列）
      const statsGrid = statsSection.createDiv("focus-stats-grid");
      // 根据宽度设置网格列数
      if (isNarrow) {
        statsGrid.classList.add("focus-stats-grid-narrow");
      } else {
        statsGrid.classList.remove("focus-stats-grid-narrow");
      }
      
      // 今日专注
      this.createStatCard(statsGrid, t("todayFocus"), 
        formatTimeChinese(stats.today),
        `${t("yesterday")} ${stats.yesterdayDiff >= 0 ? '+' : '-'}${formatTimeShort(Math.abs(stats.yesterdayDiff))}`,
        `${t("avg7Days")} ${formatTimeShort(stats.avg7Days)}`);
      
      // 今日完成
      this.createStatCard(statsGrid, t("todayCompleted"),
        `${stats.todayCompleted} ${t("tasks")}`,
        `${t("yesterday")} ${stats.yesterdayCompletedDiff >= 0 ? '+' : '-'}${Math.abs(stats.yesterdayCompletedDiff)}`,
        `${t("avg7Days")} ${stats.avg7DaysCompleted.toFixed(1)} ${t("tasks")}`);
      
      // 本月平均专注
      this.createStatCard(statsGrid, t("monthlyAvgFocus"),
        formatTimeChinese(stats.avgCurrentMonth),
        `${t("lastMonth")} ${stats.monthDiff >= 0 ? '+' : '-'}${formatTimeShort(Math.abs(stats.monthDiff))}`,
        `${t("monthlyAvg")} ${stats.avgCurrentMonthCompleted.toFixed(1)} ${t("tasks")}`);
      
      // 全年总专注
      this.createStatCard(statsGrid, t("yearlyTotalFocus"),
        formatTimeChinese(stats.yearTotal),
        null, // 不显示对比数据
        `${t("yearlyTotalCompleted")} ${stats.yearCompleted} ${t("tasks")}`);

      // 最近专注记录
      const historySection = viewContainer.createDiv("focus-history-section");
      if (this.currentView !== "history") {
        historySection.classList.add("focus-section-hidden");
      }
      const historyContent = historySection.createDiv("focus-history-content");
      this.createRecentHistory(historyContent, sessions);
      
      // 切换按钮事件
      statsToggleBtn.onclick = () => {
        this.currentView = "stats";
        statsSection.classList.remove("focus-section-hidden");
        historySection.classList.add("focus-section-hidden");
        statsToggleBtn.classList.add("focus-view-toggle-active");
        historyToggleBtn.classList.remove("focus-view-toggle-active");
      };
      
      historyToggleBtn.onclick = () => {
        this.currentView = "history";
        statsSection.classList.add("focus-section-hidden");
        historySection.classList.remove("focus-section-hidden");
        historyToggleBtn.classList.add("focus-view-toggle-active");
        statsToggleBtn.classList.remove("focus-view-toggle-active");
      };
      
      // 设置初始状态
      if (this.currentView === "stats") {
        statsToggleBtn.classList.add("focus-view-toggle-active");
      } else {
        historyToggleBtn.classList.add("focus-view-toggle-active");
      }
    }
  }

  createStatCard(container, title, mainValue, comparison, average) {
    const card = container.createDiv("focus-stat-card");
    card.createEl("div", { text: title, cls: "focus-stat-card-title" });
    
    // 主值行：包含当前值和昨天的对比（同一行）
    const mainValueRow = card.createDiv("focus-stat-main-row");
    const mainValueEl = mainValueRow.createDiv("focus-stat-main-value");
    
    // 如果mainValue是对象（包含数字和单位），分开显示
    if (typeof mainValue === 'object' && mainValue.number) {
      const numberSpan = mainValueEl.createEl("span", { text: mainValue.number, cls: "focus-stat-number" });
      if (mainValue.unit) {
        mainValueEl.createEl("span", { text: mainValue.unit, cls: "focus-stat-unit" });
      }
      if (mainValue.number2) {
        mainValueEl.createEl("span", { text: mainValue.number2, cls: "focus-stat-number" });
      }
      if (mainValue.unit2) {
        mainValueEl.createEl("span", { text: mainValue.unit2, cls: "focus-stat-unit" });
      }
    } else {
      // 处理"X 个任务"这种格式
      const parts = String(mainValue).split(/(\d+)/);
      parts.forEach(part => {
        if (part && !isNaN(part)) {
          mainValueEl.createEl("span", { text: part, cls: "focus-stat-number" });
        } else if (part) {
          mainValueEl.createEl("span", { text: part, cls: "focus-stat-unit" });
        }
      });
    }
    
    // 对比数据（放在右侧，标签在上一行，值在下一行）
    if (comparison) {
      // 解析comparison字符串，提取正负号和数值
      // 格式可能是："昨天+44分钟" 或 "昨天-10分钟" 或 "上月+44分钟" 或 "上月-10分钟"
      // 注意：标签和符号之间可能有空格
      const lang = getLanguage();
      let comparisonMatch;
      if (lang === 'zh') {
        comparisonMatch = comparison.match(/(昨天|前一天|前天|上月)\s*([+-])([\d.]+.*)/);
      } else {
        // 英文标签：Yesterday, Previous Day, Last Month
        comparisonMatch = comparison.match(/(Yesterday|Previous Day|Last Month)\s*([+-])([\d.]+.*)/);
      }
      if (comparisonMatch) {
        const label = comparisonMatch[1];
        const sign = comparisonMatch[2];
        const value = comparisonMatch[3];
        const isPositive = sign === '+';
        
        const comparisonEl = mainValueRow.createDiv({ 
          cls: `focus-stat-comparison ${isPositive ? 'comparison-positive' : 'comparison-negative'}` 
        });
        // 标签在上一行
        comparisonEl.createEl("div", { text: label, cls: "comparison-label" });
        // 值在下一行
        comparisonEl.createEl("div", { text: `${sign}${value}`, cls: "comparison-value" });
      } else {
        // 如果都不匹配，直接显示
        const comparisonEl = mainValueRow.createDiv({ text: comparison, cls: "focus-stat-comparison" });
      }
    }
    
    // 平均值（单独一行）
    if (average) {
      // 检查是否是"全年累计完成"，如果是则添加额外的类
      const isYearlyTotal = average.includes(t("yearlyTotalCompleted")) || average.includes("全年累计完成");
      const averageClasses = isYearlyTotal ? "focus-stat-average focus-stat-average-yearly" : "focus-stat-average";
      const averageEl = card.createEl("div", { text: average, cls: averageClasses });
    }
  }

  createRecentHistory(container, sessions) {
    // 按时间排序，获取最近10条记录
    const sortedSessions = [...sessions].sort((a, b) => {
      return new Date(b.start).getTime() - new Date(a.start).getTime();
    }).slice(0, 10);
    
    // 按日期分组（保持倒序）
    const byDate = {};
    sortedSessions.forEach(s => {
      const dateKey = getDateKey(new Date(s.start));
      if (!byDate[dateKey]) {
        byDate[dateKey] = [];
      }
      byDate[dateKey].push(s); // 已经是倒序的，直接push
    });
    
    // 获取最近几天的记录（最多7天），倒序显示（最新的日期在前）
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const dates = Object.keys(byDate).sort().reverse().slice(0, 7);
    
    if (dates.length === 0) {
      const emptyEl = container.createDiv("focus-history-empty");
      emptyEl.textContent = t("noRecentFocus");
      return;
    }
    
    dates.forEach(dateKey => {
      const date = new Date(dateKey);
      const isToday = dateKey === getDateKey(new Date());
      const dateLabel = isToday ? t("today") : (getLanguage() === 'zh' ? `${date.getMonth() + 1}月${date.getDate()}日` : `${date.getMonth() + 1}/${date.getDate()}`);
      
      const dateGroup = container.createDiv("focus-history-date-group");
      dateGroup.createEl("div", { text: dateLabel, cls: "focus-history-date-label" });
      
      // 倒序显示，最新的在上面（不reverse，因为sortedSessions已经是倒序的）
      byDate[dateKey].forEach(session => {
        const item = dateGroup.createDiv("focus-history-item");
        const time = new Date(session.start);
        const timeStr = `${String(time.getHours()).padStart(2, '0')}:${String(time.getMinutes()).padStart(2, '0')}`;
        
        // 显示专注事项名称，如果没有则显示默认文本
        const noteText = session.note && session.note.trim() 
          ? session.note.trim() 
          : t("oneTask");
        
        let entryText = "";
        if (session.status === "completed") {
          // 完成了（一个任务/任务名），26分钟
          const lang = getLanguage();
          entryText = lang === 'zh' 
            ? `${timeStr} ${t("completed")} ${noteText}，${formatTimeShort(session.actualSec)}`
            : `${timeStr} ${t("completed")} ${noteText}, ${formatTimeShort(session.actualSec)}`;
        } else {
          // 放弃了（一个任务/任务名）
          entryText = `${timeStr} ${t("abandoned")} ${noteText}`;
        }
        
        item.createEl("div", { 
          text: entryText,
          cls: `focus-history-entry ${session.status === "completed" ? "status-completed" : "status-abandoned"}`
        });
      });
    });
  }

  async showChart() {
    try {
      // 创建图表视图（模态框）
      const chartModal = document.createElement("div");
      chartModal.className = "focus-chart-modal";
      
      const chartContent = document.createElement("div");
      chartContent.className = "focus-chart-content";
      
      const closeBtn = document.createElement("button");
      closeBtn.textContent = t("close");
      closeBtn.className = "focus-chart-close-btn";
      closeBtn.onclick = () => chartModal.remove();
      
      const title = document.createElement("h3");
      title.textContent = t("focusTrendChart");
      title.className = "focus-chart-modal-title";
      
      chartContent.appendChild(closeBtn);
      chartContent.appendChild(title);

      // 显示选项（默认都勾选）：专注时间 / 任务数量
      const controls = document.createElement("div");
      controls.className = "focus-chart-modal-controls";
      const makeCheckbox = (labelText, checked) => {
        const label = document.createElement("label");
        label.className = "focus-chart-modal-checkbox-label";
        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.checked = checked;
        label.appendChild(cb);
        label.appendChild(document.createTextNode(labelText));
        return { label, cb };
      };
      const { label: showTimeLabel, cb: showTimeCb } = makeCheckbox(t("showFocusTimeChart"), true);
      const { label: showCountLabel, cb: showCountCb } = makeCheckbox(t("showTaskCountChart"), true);
      controls.appendChild(showTimeLabel);
      controls.appendChild(showCountLabel);
      chartContent.appendChild(controls);
      
      // 点击模态框背景（非内容区域）可以关闭
      chartModal.onclick = (e) => {
        if (e.target === chartModal) {
          chartModal.remove();
        }
      };
      
      // 阻止内容区域的点击事件冒泡
      chartContent.onclick = (e) => {
        e.stopPropagation();
      };
      
      // 获取数据
      const sessions = await readSessions(this.plugin.app);
      
      // 内部范围键（供 calculateChartData 使用，与语言无关）
      const rangeKeys = ["7天", "14天", "30天", "本月", "今年"];
      // 显示用标签（随语言变化）
      const chartRangeLabels = [t("days7"), t("days14"), t("days30"), t("thisMonth"), t("thisYear")];

      const charts = []; // { container, data }
      const redrawAll = () => {
        const opts = { showTime: showTimeCb.checked, showCount: showCountCb.checked };
        charts.forEach(({ container, data }) => {
          this.createLineChart(container, data, opts);
        });
      };
      showTimeCb.addEventListener("change", redrawAll);
      showCountCb.addEventListener("change", redrawAll);
      
      // 为每个范围创建图表
      rangeKeys.forEach((rangeKey, index) => {
        const rangeLabel = chartRangeLabels[index];
        try {
          const chartSection = document.createElement("div");
          chartSection.className = "focus-chart-section";
          
          const chartTitle = document.createElement("h4");
          chartTitle.textContent = `${t("focusTrend")} (${rangeLabel})`;
          chartTitle.className = "focus-chart-section-title";
          
          const chartContainer = document.createElement("div");
          chartContainer.className = "focus-chart-container";
          
          // 下载按钮
          const downloadBtn = document.createElement("button");
          downloadBtn.textContent = t("download");
          downloadBtn.className = "focus-chart-download-btn focus-chart-download-btn-positioned";
          downloadBtn.onclick = () => {
            const canvas = chartContainer.querySelector("canvas");
            if (canvas) {
              const link = document.createElement("a");
              const lang = getLanguage();
              link.download = lang === 'zh' 
                ? `${t("focusTrend")}-${rangeLabel}-${new Date().toISOString().split('T')[0]}.png`
                : `FocusTrend-${rangeLabel}-${new Date().toISOString().split('T')[0]}.png`;
              link.href = canvas.toDataURL("image/png");
              link.click();
            }
          };
          
          chartSection.appendChild(chartTitle);
          chartSection.appendChild(chartContainer);
          chartContainer.appendChild(downloadBtn);
          
          // 计算该范围的数据（使用内部键，与界面语言无关）
          let chartData;
          try {
            chartData = calculateChartData(sessions, rangeKey);
          } catch (calcError) {
            throw calcError;
          }
          
          // 绘制图表
          if (chartData && Array.isArray(chartData) && chartData.length > 0) {
            try {
              charts.push({ container: chartContainer, data: chartData });
              this.createLineChart(chartContainer, chartData, { showTime: showTimeCb.checked, showCount: showCountCb.checked });
            } catch (drawError) {
              const errorMsg = document.createElement("div");
              errorMsg.textContent = `${t("chartError")}: ${drawError.message}`;
              errorMsg.className = "focus-chart-error-message";
              chartContainer.appendChild(errorMsg);
            }
          } else {
            const emptyMsg = document.createElement("div");
            emptyMsg.textContent = t("noData");
            emptyMsg.className = "focus-chart-empty-message";
            chartContainer.appendChild(emptyMsg);
          }
          
          chartContent.appendChild(chartSection);
        } catch (error) {
          const errorSection = document.createElement("div");
          errorSection.className = "focus-chart-section";
          const errorMsg = document.createElement("div");
          const lang = getLanguage();
          errorMsg.textContent = lang === 'zh' 
            ? `创建图表（${rangeLabel}）时出错: ${error.message}`
            : `Error creating chart (${rangeLabel}): ${error.message}`;
          errorMsg.className = "focus-chart-error-message";
          errorSection.appendChild(errorMsg);
          chartContent.appendChild(errorSection);
        }
      });
      
      chartModal.appendChild(chartContent);
      document.body.appendChild(chartModal);
    } catch (error) {
      new Notice(`${t("openChartError")}: ${error.message}`, 5000);
    }
  }

  createLineChart(container, data, opts = { showTime: true, showCount: true }) {
    createLineChart(container, data, { ...opts, interactive: true });
  }
}

class FocusTimerSettingTab extends PluginSettingTab {
  plugin;
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;

    containerEl.empty();

    // Timer设置分组
    new Setting(containerEl)
      .setName(t("timerSettings"))
      .setHeading();

    // 1. 倒计时结束后自动继续计时设置
    new Setting(containerEl)
      .setName(t("autoContinueAfterCountdown"))
      .setDesc(t("autoContinueDesc"))
      .addToggle(toggle => {
        toggle
          .setValue(this.plugin.settings.autoContinue)
          .onChange(async (value) => {
            this.plugin.settings.autoContinue = value;
            await this.plugin.saveSettings();
          });
      });

    // 2. 倒计时允许提前完成
    new Setting(containerEl)
      .setName(t("allowCompleteCountdownEarly"))
      .setDesc(t("allowCompleteCountdownEarlyDesc"))
      .addToggle(toggle => {
        toggle
          .setValue(this.plugin.settings.allowCompleteCountdownEarly ?? false)
          .onChange(async (value) => {
            this.plugin.settings.allowCompleteCountdownEarly = value;
            await this.plugin.saveSettings();
            this.plugin.updateView();
          });
      });

    // 3. 键盘快捷键设置
    new Setting(containerEl)
      .setName(t("keyboardShortcuts"))
      .setDesc(t("keyboardShortcutsDesc"))
      .addToggle(toggle => {
        toggle
          .setValue(this.plugin.settings.keyboardShortcuts ?? false)
          .onChange(async (value) => {
            this.plugin.settings.keyboardShortcuts = value;
            await this.plugin.saveSettings();
          });
      });

    // 4. 状态栏显示专注情况
    new Setting(containerEl)
      .setName(t("statusBarShowFocus"))
      .setDesc(t("statusBarShowFocusDesc"))
      .addToggle(toggle => {
        toggle
          .setValue(this.plugin.settings.statusBarShowFocus !== false)
          .onChange(async (value) => {
            this.plugin.settings.statusBarShowFocus = value;
            await this.plugin.saveSettings();
            if (value) {
              if (!this.plugin.statusBarEl) {
                this.plugin.statusBarEl = this.plugin.addStatusBarItem();
                this.plugin.statusBarEl.setText(getLanguage() === 'zh' ? "专注计时器" : "Focus Timer");
                this.plugin.statusBarEl.addClass("focus-timer-statusbar");
                this.plugin.statusBarEl.onClickEvent(() => this.plugin.openView());
              }
              this.plugin.updateStatusBarDisplay();
              this.plugin.startStatusBarTimer();
            } else {
              this.plugin.stopStatusBarTimer();
              if (this.plugin.statusBarEl) {
                this.plugin.statusBarEl.remove();
                this.plugin.statusBarEl = null;
              }
            }
          });
      });

    // 5. 默认模式设置
    new Setting(containerEl)
      .setName(t("defaultMode"))
      .setDesc(t("defaultModeDesc"))
      .addDropdown(dropdown => {
        dropdown
          .addOption("countdown", t("countdown"))
          .addOption("stopwatch", t("stopwatch"))
          .setValue(this.plugin.settings.defaultMode)
          .onChange(async (value) => {
            this.plugin.settings.defaultMode = value;
            await this.plugin.saveSettings();
            // 更新视图
            this.plugin.updateView();
          });
      });

    // 4. 默认倒计时时间设置
    new Setting(containerEl)
      .setName(t("defaultDurationMinutes"))
      .setDesc(t("defaultDurationMinutesDesc"))
      .addText(text => {
        const currentValue = this.plugin.settings.defaultDurationMinutes || 25;
        text
          .setPlaceholder("25")
          .setValue(currentValue ? String(currentValue) : "");
        text.inputEl.type = "number";
        text.inputEl.min = "1";
        text.inputEl.max = "600";
        text.inputEl.step = "1";
        // 限制只能输入整数（不允许小数），且最大值为600
        text.inputEl.addEventListener("input", (e) => {
          const value = e.target.value;
          // 如果输入包含小数点，移除小数点及之后的内容
          if (value.includes(".")) {
            const intValue = Math.floor(parseFloat(value));
            e.target.value = intValue > 0 ? String(intValue) : "";
          }
          // 如果输入大于600，自动改为600
          const numValue = parseInt(e.target.value, 10);
          if (!isNaN(numValue) && numValue > 600) {
            e.target.value = "600";
          }
        });
        text.onChange(async (value) => {
          // 只接受正整数，最大600，空白时使用默认值25
          if (value === "" || value === null || value === undefined) {
            this.plugin.settings.defaultDurationMinutes = 25;
            text.setValue(""); // 显示为空，但实际使用默认值25
          } else {
            const numValue = parseInt(value, 10);
            if (!isNaN(numValue) && numValue > 0 && Number.isInteger(numValue)) {
              // 如果大于600，自动改为600
              this.plugin.settings.defaultDurationMinutes = Math.min(numValue, 600);
              if (numValue > 600) {
                text.setValue("600");
              }
            } else {
              // 无效值，恢复为默认值
              this.plugin.settings.defaultDurationMinutes = 25;
              text.setValue("");
            }
          }
          await this.plugin.saveSettings();
          // 防抖更新视图，最多500ms刷新一次（使用统一定时器管理器）
          this.plugin.timerManager.clear("setting-view-debounce");
          this.plugin.timerManager.setTimeout("setting-view-debounce", 500, () => {
            this.plugin.updateView();
          });
        });
      });

    // 5. 加/减号步长设置
    new Setting(containerEl)
      .setName(t("adjustStepMinutes"))
      .setDesc(t("adjustStepMinutesDesc"))
      .addText(text => {
        const currentValue = this.plugin.settings.adjustStepMinutes || 5;
        text
          .setPlaceholder("5")
          .setValue(currentValue ? String(currentValue) : "");
        text.inputEl.type = "number";
        text.inputEl.min = "1";
        text.inputEl.max = "60";
        text.inputEl.step = "1";
        // 只能输入 1-60 的整数
        text.inputEl.addEventListener("input", (e) => {
          const value = e.target.value;
          if (value.includes(".")) {
            const intValue = Math.floor(parseFloat(value));
            e.target.value = intValue > 0 ? String(intValue) : "";
          }
          const numValue = parseInt(e.target.value, 10);
          if (!isNaN(numValue) && numValue > 60) {
            e.target.value = "60";
          } else if (!isNaN(numValue) && numValue < 1) {
            e.target.value = "1";
          }
        });
        text.onChange(async (value) => {
          if (value === "" || value === null || value === undefined) {
            this.plugin.settings.adjustStepMinutes = 5;
            text.setValue("");
          } else {
            const numValue = parseInt(value, 10);
            if (!isNaN(numValue) && numValue >= 1 && numValue <= 60 && Number.isInteger(numValue)) {
              this.plugin.settings.adjustStepMinutes = numValue;
            } else {
              this.plugin.settings.adjustStepMinutes = 5;
              text.setValue("");
            }
          }
          await this.plugin.saveSettings();
        });
      });

    // 6. 计时结束后自动进入休息设置
    new Setting(containerEl)
      .setName(t("autoRest"))
      .setDesc(t("autoRestDesc"))
      .addToggle(toggle => {
        toggle
          .setValue(this.plugin.settings.autoRest || false)
          .onChange(async (value) => {
            this.plugin.settings.autoRest = value;
            await this.plugin.saveSettings();
          });
      });

    // 7. 默认休息时间设置
    new Setting(containerEl)
      .setName(t("defaultRestMinutes"))
      .setDesc(t("defaultRestMinutesDesc"))
      .addText(text => {
        const currentValue = this.plugin.settings.defaultRestMinutes || 5;
        text
          .setPlaceholder("5")
          .setValue(currentValue ? String(currentValue) : "");
        text.inputEl.type = "number";
        text.inputEl.min = "1";
        text.inputEl.max = "600";
        text.inputEl.step = "1";
        // 限制只能输入整数（不允许小数），且最大值为600
        text.inputEl.addEventListener("input", (e) => {
          const value = e.target.value;
          // 如果输入包含小数点，移除小数点及之后的内容
          if (value.includes(".")) {
            const intValue = Math.floor(parseFloat(value));
            e.target.value = intValue > 0 ? String(intValue) : "";
          }
          // 如果输入大于600，自动改为600
          const numValue = parseInt(e.target.value, 10);
          if (!isNaN(numValue) && numValue > 600) {
            e.target.value = "600";
          }
        });
        text.onChange(async (value) => {
          // 只接受正整数，最大600，空白时使用默认值5
          if (value === "" || value === null || value === undefined) {
            this.plugin.settings.defaultRestMinutes = 5;
            text.setValue(""); // 显示为空，但实际使用默认值5
          } else {
            const numValue = parseInt(value, 10);
            if (!isNaN(numValue) && numValue > 0 && Number.isInteger(numValue)) {
              // 如果大于600，自动改为600
              this.plugin.settings.defaultRestMinutes = Math.min(numValue, 600);
              if (numValue > 600) {
                text.setValue("600");
              }
            } else {
              // 无效值，恢复为默认值
              this.plugin.settings.defaultRestMinutes = 5;
              text.setValue("");
            }
          }
          await this.plugin.saveSettings();
        });
      });

    // 快捷Timer设置
    new Setting(containerEl)
      .setName(t("quickTimer"))
      .setHeading();
    
    // 快捷Timer 1
    new Setting(containerEl)
      .setName(t("quickTimer1"))
      .setDesc(t("quickTimerDesc"))
      .addText(text => {
        text
          .setPlaceholder(t("timerName"))
          .setValue(this.plugin.settings.quickTimer1?.name || "");
        // 实时限制输入长度
        text.inputEl.addEventListener("input", (e) => {
          const value = e.target.value;
          const limited = limitInputLength(value);
          if (value !== limited) {
            e.target.value = limited;
          }
        });
        text.onChange(async (value) => {
          if (!this.plugin.settings.quickTimer1) {
            this.plugin.settings.quickTimer1 = { name: "", minutes: 25 };
          }
          // 限制名称长度：英文字符最多40个
          const limitedValue = limitInputLength(value || "");
          this.plugin.settings.quickTimer1.name = limitedValue;
          if (value !== limitedValue) {
            text.setValue(limitedValue);
          }
          await this.plugin.saveSettings();
        });
      })
      .addText(text => {
        const currentMinutes = this.plugin.settings.quickTimer1?.minutes || 25;
        text
          .setPlaceholder("25")
          .setValue(currentMinutes ? String(currentMinutes) : "");
        text.inputEl.type = "number";
        text.inputEl.min = "1";
        text.inputEl.max = "600";
        text.inputEl.step = "1";
        text.onChange(async (value) => {
          if (!this.plugin.settings.quickTimer1) {
            this.plugin.settings.quickTimer1 = { name: "", minutes: 25 };
          }
          if (value === "" || value === null || value === undefined) {
            this.plugin.settings.quickTimer1.minutes = 25;
            text.setValue("");
          } else {
            const numValue = parseInt(value, 10);
            if (!isNaN(numValue) && numValue > 0 && Number.isInteger(numValue)) {
              this.plugin.settings.quickTimer1.minutes = Math.min(numValue, 600);
              if (numValue > 600) {
                text.setValue("600");
              }
            } else {
              this.plugin.settings.quickTimer1.minutes = 25;
              text.setValue("");
            }
          }
          await this.plugin.saveSettings();
        });
      });

    // 快捷Timer 2
    new Setting(containerEl)
      .setName(t("quickTimer2"))
      .setDesc(t("quickTimerDesc2"))
      .addText(text => {
        text
          .setPlaceholder(t("timerName"))
          .setValue(this.plugin.settings.quickTimer2?.name || "");
        // 实时限制输入长度
        text.inputEl.addEventListener("input", (e) => {
          const value = e.target.value;
          const limited = limitInputLength(value);
          if (value !== limited) {
            e.target.value = limited;
          }
        });
        text.onChange(async (value) => {
          if (!this.plugin.settings.quickTimer2) {
            this.plugin.settings.quickTimer2 = { name: "", minutes: 25 };
          }
          // 限制名称长度：英文字符最多40个
          const limitedValue = limitInputLength(value || "");
          this.plugin.settings.quickTimer2.name = limitedValue;
          if (value !== limitedValue) {
            text.setValue(limitedValue);
          }
          await this.plugin.saveSettings();
        });
      })
      .addText(text => {
        const currentMinutes = this.plugin.settings.quickTimer2?.minutes || 25;
        text
          .setPlaceholder("25")
          .setValue(currentMinutes ? String(currentMinutes) : "");
        text.inputEl.type = "number";
        text.inputEl.min = "1";
        text.inputEl.max = "600";
        text.inputEl.step = "1";
        text.onChange(async (value) => {
          if (!this.plugin.settings.quickTimer2) {
            this.plugin.settings.quickTimer2 = { name: "", minutes: 25 };
          }
          if (value === "" || value === null || value === undefined) {
            this.plugin.settings.quickTimer2.minutes = 25;
            text.setValue("");
          } else {
            const numValue = parseInt(value, 10);
            if (!isNaN(numValue) && numValue > 0 && Number.isInteger(numValue)) {
              this.plugin.settings.quickTimer2.minutes = Math.min(numValue, 600);
              if (numValue > 600) {
                text.setValue("600");
              }
            } else {
              this.plugin.settings.quickTimer2.minutes = 25;
              text.setValue("");
            }
          }
          await this.plugin.saveSettings();
        });
      });

    // 快捷Timer 3
    new Setting(containerEl)
      .setName(t("quickTimer3"))
      .setDesc(t("quickTimerDesc3"))
      .addText(text => {
        text
          .setPlaceholder(t("timerName"))
          .setValue(this.plugin.settings.quickTimer3?.name || "");
        // 实时限制输入长度
        text.inputEl.addEventListener("input", (e) => {
          const value = e.target.value;
          const limited = limitInputLength(value);
          if (value !== limited) {
            e.target.value = limited;
          }
        });
        text.onChange(async (value) => {
          if (!this.plugin.settings.quickTimer3) {
            this.plugin.settings.quickTimer3 = { name: "", minutes: 25 };
          }
          // 限制名称长度：英文字符最多40个
          const limitedValue = limitInputLength(value || "");
          this.plugin.settings.quickTimer3.name = limitedValue;
          if (value !== limitedValue) {
            text.setValue(limitedValue);
          }
          await this.plugin.saveSettings();
        });
      })
      .addText(text => {
        const currentMinutes = this.plugin.settings.quickTimer3?.minutes || 25;
        text
          .setPlaceholder("25")
          .setValue(currentMinutes ? String(currentMinutes) : "");
        text.inputEl.type = "number";
        text.inputEl.min = "1";
        text.inputEl.max = "600";
        text.inputEl.step = "1";
        text.onChange(async (value) => {
          if (!this.plugin.settings.quickTimer3) {
            this.plugin.settings.quickTimer3 = { name: "", minutes: 25 };
          }
          if (value === "" || value === null || value === undefined) {
            this.plugin.settings.quickTimer3.minutes = 25;
            text.setValue("");
          } else {
            const numValue = parseInt(value, 10);
            if (!isNaN(numValue) && numValue > 0 && Number.isInteger(numValue)) {
              this.plugin.settings.quickTimer3.minutes = Math.min(numValue, 600);
              if (numValue > 600) {
                text.setValue("600");
              }
            } else {
              this.plugin.settings.quickTimer3.minutes = 25;
              text.setValue("");
            }
          }
          await this.plugin.saveSettings();
        });
      });

    // Focus 代码块图表默认设置
    new Setting(containerEl)
      .setName(t("codeBlockChartSettings"))
      .setHeading();
    
    // 1. 显示专注时间（代码块）
    new Setting(containerEl)
      .setName(t("showFocusTime"))
      .setDesc(t("showFocusTimeDesc"))
      .addToggle(toggle => {
        toggle
          .setValue(this.plugin.settings.codeBlockChartShowTime ?? true)
          .onChange(async (value) => {
            this.plugin.settings.codeBlockChartShowTime = value;
            await this.plugin.saveSettings();
          });
      });
    // 2. 显示任务完成数量（代码块）
    new Setting(containerEl)
      .setName(t("showTaskCount"))
      .setDesc(t("showTaskCountDesc"))
      .addToggle(toggle => {
        toggle
          .setValue(this.plugin.settings.codeBlockChartShowCount ?? true)
          .onChange(async (value) => {
            this.plugin.settings.codeBlockChartShowCount = value;
            await this.plugin.saveSettings();
          });
      });

    // 3. 默认图表显示范围设置
    new Setting(containerEl)
      .setName(t("defaultChartRange"))
      .setDesc(t("defaultChartRangeDesc"))
      .addDropdown(dropdown => {
        dropdown
          .addOption("7天", t("days7"))
          .addOption("14天", t("days14"))
          .addOption("30天", t("days30"))
          .addOption("本月", t("thisMonth"))
          .addOption("今年", t("thisYear"))
          .setValue(this.plugin.settings.defaultChartRange || "14天")
          .onChange(async (value) => {
            this.plugin.settings.defaultChartRange = value;
            await this.plugin.saveSettings();
          });
      });

    // 其他
    new Setting(containerEl)
      .setName(t("other"))
      .setHeading();
    
    // 联想任务列表
    new Setting(containerEl)
      .setName(t("suggestTasks"))
      .setDesc(t("suggestTasksDesc"))
      .addTextArea(text => {
        const list = this.plugin.settings.suggestTasks || [];
        text
          .setPlaceholder(t("suggestTasksPlaceholder"))
          .setValue(Array.isArray(list) ? list.join("\n") : "");
        text.inputEl.rows = 6;
        text.inputEl.classList.add("focus-settings-textarea");
        text.inputEl.addEventListener("input", (e) => {
          const ta = e.target;
          let v = ta.value;
          let lines = v.split(/\r?\n/);
          if (lines.length > MAX_SUGGEST_TASKS) {
            lines = lines.slice(0, MAX_SUGGEST_TASKS);
            v = lines.join("\n");
            ta.value = v;
          }
          const limited = lines.map((line) => limitInputLength(line));
          const newV = limited.join("\n");
          if (newV !== v) {
            ta.value = newV;
          }
        });
        text.onChange(async (value) => {
          const arr = (value || "")
            .split(/\r?\n/)
            .map((s) => limitInputLength(s.trim()))
            .filter(Boolean)
            .slice(0, MAX_SUGGEST_TASKS);
          this.plugin.settings.suggestTasks = arr;
          await this.plugin.saveSettings();
        });
      });

    // 导出数据
    new Setting(containerEl)
      .setName(t("exportData"))
      .setDesc(t("exportDataDesc"))
      .addButton(button => {
        button
          .setButtonText(t("exportCSV"))
          .setCta()
          .onClick(async () => {
            try {
              await this.exportDataToCSV();
              new Notice(t("exportSuccess"));
            } catch (error) {
              new Notice(`${t("exportFailed")}: ${error.message}`, 5000);
            }
          });
      });

    // 删除所有历史记录
    new Setting(containerEl)
      .setName(t("deleteAllHistory"))
      .setDesc(t("deleteAllHistoryDesc"))
      .addButton(button => {
        button
          .setButtonText(t("deleteAllHistory"))
          .setWarning()
          .onClick(() => {
            const modal = new ConfirmModal(
              this.app,
              t("deleteAllHistory"),
              t("deleteAllHistoryConfirm"),
              async () => {
                try {
                  await writeSessions(this.plugin.app, []);
                  new Notice(t("deleteAllHistorySuccess"));
                } catch (error) {
                  new Notice(`${t("deleteFailed")}: ${error.message}`, 5000);
                }
              }
            );
            modal.open();
          });
      });
  }

  // 导出数据为CSV
  async exportDataToCSV() {
    const sessions = await readSessions(this.plugin.app);
    
    if (sessions.length === 0) {
      new Notice(t("noDataToExport"), 3000);
      return;
    }

    // CSV表头
    const headers = t("csvHeaders");

    // 转换数据为CSV行
    const csvRows = [headers.join(",")];
    
    sessions.forEach(session => {
      const plannedMinutes = session.plannedSec ? Math.round(session.plannedSec / 60) : "";
      const actualMinutes = session.actualSec ? Math.round(session.actualSec / 60) : "";
      const statusText = session.status === "completed" ? t("completedStatus") : t("abandonedStatus");
      
      // 转义CSV字段（处理逗号、引号、换行符）
      const escapeCSV = (field) => {
        if (field === null || field === undefined) return "";
        const str = String(field);
        if (str.includes(",") || str.includes('"') || str.includes("\n")) {
          return `"${str.replace(/"/g, '""')}"`;
        }
        return str;
      };

      const row = [
        escapeCSV(session.id),
        escapeCSV(session.start),
        escapeCSV(session.end || ""),
        escapeCSV(session.plannedSec || ""),
        escapeCSV(plannedMinutes),
        escapeCSV(session.actualSec || ""),
        escapeCSV(actualMinutes),
        escapeCSV(statusText),
        escapeCSV(session.note || ""),
        escapeCSV(session.createdAt)
      ];
      
      csvRows.push(row.join(","));
    });

    // 生成CSV内容
    const csvContent = csvRows.join("\n");
    
    // 添加BOM以支持中文（UTF-8 with BOM）
    const BOM = "\uFEFF";
    const csvWithBOM = BOM + csvContent;

    // 创建下载链接
    const blob = new Blob([csvWithBOM], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    
    // 生成文件名（包含当前日期）
    const now = new Date();
    const dateStr = now.toISOString().split("T")[0];
    link.download = `${t("csvFilename")}-${dateStr}.csv`;
    
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }
}

module.exports = class FocusTimerPlugin extends Plugin {
  statusBarEl = null;
  timerManager = new TimerManager();
  statusBarStartTime = null; // 本地记录的开始时间
  statusBarPlannedSec = null; // 计划时长
  statusBarMode = null; // "focus" | "rest" | null
  settings = {
    autoContinue: false, // 倒计时结束后是否自动继续计时
    defaultMode: "countdown", // 默认模式：countdown（倒计时）或 stopwatch（正计时）
    adjustStepMinutes: 5, // 加/减按钮每次增减的分钟数（1-60）
    defaultChartRange: "14天", // 默认图表显示范围：7天/14天/30天/本月/今年
    defaultDurationMinutes: 25, // 默认倒计时时间（分钟），不填写时默认25分钟
    quickTimer1: { name: "", minutes: 25 }, // 快捷timer 1
    quickTimer2: { name: "", minutes: 25 }, // 快捷timer 2
    quickTimer3: { name: "", minutes: 25 }, // 快捷timer 3
    autoRest: false, // 是否在计时结束后自动进入休息
    defaultRestMinutes: 5, // 默认休息时间（分钟）
    keyboardShortcuts: false, // 聚焦面板时：Enter 开始，上/下 加减时间
    statusBarShowFocus: true, // 状态栏是否显示专注/休息计时
    allowCompleteCountdownEarly: false, // 倒计时进行时是否允许提前完成（关则只显示放弃、命令完成不可用）
    suggestTasks: [], // 联想任务列表（专注事项输入时联想；新任务开始后自动加入）
    codeBlockChartShowTime: true, // focus 代码块图表默认：显示专注时间
    codeBlockChartShowCount: true // focus 代码块图表默认：显示任务数量
  };

  async onload() {
    // 保险：若无 data.json 则创建默认模板，防止启动失败
    await ensureDataFileExists(this.app);

    // 初始化语言检测（延迟执行以确保 DOM 已加载，使用统一定时器管理器）
    this.timerManager.setTimeout("init-language", 100, () => {
      resetLanguageCache();
      getLanguage();
    });
    
    // 加载CSS样式文件
    try {
      // 方法1: 尝试使用vault adapter读取（适用于iCloud同步的vault）
      const cssPath = ".obsidian/plugins/focus-timer/styles.css";
      try {
        const cssContent = await this.app.vault.adapter.read(cssPath);
        const styleEl = document.createElement("style");
        styleEl.textContent = cssContent;
        document.head.appendChild(styleEl);
        this.styleEl = styleEl;
      } catch (vaultError) {
        // 方法2: 如果vault adapter失败，使用Node.js fs模块
        const fs = require("fs");
        const path = require("path");
        // 尝试从vault根目录读取
        const vaultPath = this.app.vault.adapter.basePath;
        const fullPath = path.join(vaultPath, ".obsidian", "plugins", "focus-timer", "styles.css");
        
        if (fs.existsSync(fullPath)) {
          const cssContent = fs.readFileSync(fullPath, "utf8");
          const styleEl = document.createElement("style");
          styleEl.textContent = cssContent;
          document.head.appendChild(styleEl);
          this.styleEl = styleEl;
        }
      }
    } catch (error) {
      // 忽略CSS加载错误
    }

    await ensureDataFileExists(this.app);

    // 加载设置
    await this.loadSettings();

    // 添加设置标签页
    this.addSettingTab(new FocusTimerSettingTab(this.app, this));

    this._keydownHandler = (e) => {
      if (!this.settings.keyboardShortcuts) return;
      const leaf = this.app.workspace.getActiveViewOfType(FocusTimerView);
      if (!leaf) return;
      const el = document.activeElement;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable)) return;
      const view = leaf;
      if (e.key === "Enter") {
        view.handleKeyboardEnter();
        e.preventDefault();
      } else if (e.key === "ArrowUp") {
        view.handleKeyboardArrowUp();
        e.preventDefault();
      } else if (e.key === "ArrowDown") {
        view.handleKeyboardArrowDown();
        e.preventDefault();
      }
    };
    document.addEventListener("keydown", this._keydownHandler);

    // 注册代码块处理器
    this.registerMarkdownCodeBlockProcessor("focus", async (source, el, ctx) => {
      // 解析source中的参数
      // 格式：date: 2026-01-27 或 date:2026-01-27 或 date:today
      // record:none 或 items:none
      // height: 400 (设置代码块高度，单位px)
      // chart: 7 time / chart: 30 task / chart: month / chart: none
      let targetDate = null;
      let isToday = false;
      let showRecord = true; // 默认显示专注记录
      let showItems = true; // 默认显示当天专注/图表
      let height = null; // 代码块高度（px）
      // 图表相关：范围与指标
      // chartRange 可选值：'7' | '14' | '30' | 'month' | 'year' | 'none' | null
      // chartMetric 可选值：'time' | 'task' | null（null 表示同时看时长与任务数，受设置控制）
      let chartRange = null;
      let chartMetric = null;
      
      if (source && source.trim()) {
        // 解析date参数
        const todayMatch = source.match(/date\s*:\s*today/i);
        const yesterdayMatch = source.match(/date\s*:\s*yesterday/i);
        if (todayMatch) {
          isToday = true;
          // 使用今天的日期
          const today = new Date();
          targetDate = getDateKey(today);
        } else if (yesterdayMatch) {
          // 使用昨天的日期
          const yesterday = new Date();
          yesterday.setDate(yesterday.getDate() - 1);
          targetDate = getDateKey(yesterday);
        } else {
          const dateMatch = source.match(/date\s*:\s*(\d{4}-\d{2}-\d{2})/i);
          if (dateMatch) {
            targetDate = dateMatch[1];
          }
        }
        
        // 解析record参数
        const recordMatch = source.match(/record\s*:\s*none/i);
        if (recordMatch) {
          showRecord = false;
        }
        
        // 解析items参数
        const itemsMatch = source.match(/items\s*:\s*none/i);
        if (itemsMatch) {
          showItems = false;
        }
        
        // 解析height参数
        const heightMatch = source.match(/height\s*:\s*(\d+)/i);
        if (heightMatch) {
          const heightValue = parseInt(heightMatch[1], 10);
          if (!isNaN(heightValue) && heightValue > 0) {
            height = heightValue;
          }
        }

        // 解析 chart 参数
        // 支持：chart: 7, chart: 7 time, chart: 14 task, chart: month, chart: year, chart: none
        const chartMatch = source.match(/chart\s*:\s*([^\n\r]+)/i);
        if (chartMatch) {
          const chartRaw = chartMatch[1].trim();
          if (chartRaw) {
            const tokens = chartRaw.split(/[,\s]+/).filter(Boolean);
            if (tokens.length > 0) {
              const first = tokens[0].toLowerCase();
              if (first === "7" || first === "7d") {
                chartRange = "7";
              } else if (first === "14" || first === "14d") {
                chartRange = "14";
              } else if (first === "30" || first === "30d") {
                chartRange = "30";
              } else if (first === "month" || first === "本月") {
                chartRange = "month";
              } else if (first === "year" || first === "今年") {
                chartRange = "year";
              } else if (first === "none") {
                chartRange = "none";
              }
            }
            if (tokens.length > 1) {
              const second = tokens[1].toLowerCase();
              if (second === "time") {
                chartMetric = "time";
              } else if (second === "task" || second === "tasks") {
                chartMetric = "task";
              }
            }
          }
        }
      }
      
      // 如果chartRange为null，使用默认值（需要在验证之前设置，以便正确验证）
      if (chartRange === null && showItems && !targetDate) {
        chartRange = defaultChartRangeToShortKey(this.settings.defaultChartRange);
      }
      
      // 检查是否两个都为none
      // 如果没有填date：检查 record: none 和 chart: none 不能同时为none
      // 如果填了date：检查 record: none 和 items: none 不能同时为none
      let shouldShowError = false;
      if (!targetDate) {
        // 没有填date的情况：record: none 和 chart: none 不能同时为none
        if (!showRecord && chartRange === "none") {
          shouldShowError = true;
        }
      } else {
        // 填了date的情况：record: none 和 items: none 不能同时为none
        if (!showRecord && !showItems) {
          shouldShowError = true;
        }
      }
      
      if (shouldShowError) {
        // 使用安全方式清空容器
        while (el.firstChild) {
          el.removeChild(el.firstChild);
        }
        el.className = 'focus-code-block';
        const errorDiv = document.createElement('div');
        errorDiv.className = 'focus-code-error';
        errorDiv.textContent = t("bothCannotBeNone");
        el.appendChild(errorDiv);
        return;
      }
      
      // 如果是today，设置定时器在每天0:00刷新
      if (isToday) {
        this.setupDailyRefresh(el, ctx, showRecord, showItems, height, chartRange, chartMetric);
      }
      
      await this.renderFocusBlock(el, ctx, targetDate, isToday, showRecord, showItems, height, chartRange, chartMetric);
    });

    // 注册视图
    this.registerView(VIEW_TYPE, (leaf) => new FocusTimerView(leaf, this));

    // 添加命令
    this.addCommand({
      id: "focus-start-25",
      name: "Start Focus (25m)",
      callback: () => this.startFocus(25 * 60),
    });

    this.addCommand({
      id: "focus-start-50",
      name: "Start Focus (50m)",
      callback: () => this.startFocus(50 * 60),
    });

    this.addCommand({
      id: "focus-stop-complete",
      name: "Stop Focus (Complete)",
      callback: () => this.stopFocus("completed"), // 内部会根据 allowCompleteCountdownEarly 拒绝倒计时提前完成
    });

    this.addCommand({
      id: "focus-abandon",
      name: "Abandon Focus",
      callback: () => this.stopFocus("abandoned"),
    });

    this.addCommand({
      id: "focus-open-view",
      name: "Open Focus Timer View",
      callback: () => this.openView(),
    });

    // 左侧功能区（Ribbon）按钮：打开专注计时器（与状态栏同逻辑）
    this.addRibbonIcon("timer", getLanguage() === 'zh' ? "打开专注计时器" : "Open Focus Timer", () => this.openView());

    // 添加快捷Timer命令（可在设置中配置，支持快捷键绑定）
    this.registerQuickTimerCommands();

    // 状态栏：仅当设置开启时添加并显示专注情况
    if (this.settings.statusBarShowFocus !== false) {
      this.statusBarEl = this.addStatusBarItem();
      this.statusBarEl.setText(getLanguage() === 'zh' ? "专注计时器" : "Focus Timer");
      this.statusBarEl.addClass("focus-timer-statusbar");
      this.statusBarEl.onClickEvent(() => this.openView());
      this.updateStatusBarDisplay();
      this.startStatusBarTimer();
    }
  }

  async openView() {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(VIEW_TYPE)[0];
    
    if (!leaf) {
      // 使用右侧栏的 tabs（不创建新的 split 栏位），以“新选项卡”形式打开
      leaf = workspace.getRightLeaf(false);
      await leaf.setViewState({ type: VIEW_TYPE, active: true });
    }
    
    workspace.revealLeaf(leaf);
  }

  // 从文件读取状态并更新本地计时器数据（只在状态改变时调用）
  async updateStatusBarDisplay() {
    if (!this.statusBarEl) return;
    
    const state = await readState(this.app);
    
    if (state.active && !state.resting) {
      // 保存开始时间和计划时长，用于本地计时
      this.statusBarStartTime = new Date(state.start).getTime();
      this.statusBarPlannedSec = state.plannedSec;
      this.statusBarMode = "focus";
      this.statusBarEl.addClass("focus-timer-active");
      // 立即刷新一次文本（正计时/倒计时都实时显示）
      this.updateStatusBarText();
    } else if (state.resting) {
      // 休息状态
      this.statusBarStartTime = state.restStart ? new Date(state.restStart).getTime() : Date.now();
      this.statusBarPlannedSec = typeof state.restSec === "number" ? state.restSec : 0;
      this.statusBarMode = "rest";
      this.statusBarEl.removeClass("focus-timer-active");
      this.updateStatusBarText();
    } else {
      // 清除计时器数据
      this.statusBarStartTime = null;
      this.statusBarPlannedSec = null;
      this.statusBarMode = null;
      this.statusBarEl.removeClass("focus-timer-active");
      this.statusBarEl.setText(getLanguage() === 'zh' ? "专注计时器" : "Focus Timer");
    }
  }

  // 只更新状态栏文本（使用本地时间，不读取文件）
  updateStatusBarText() {
    if (!this.statusBarEl) return;

    // 休息模式：实时显示剩余时间
    if (this.statusBarMode === "rest" && this.statusBarStartTime && this.statusBarPlannedSec !== null) {
      const now = Date.now();
      const elapsed = Math.floor((now - this.statusBarStartTime) / 1000);
      const remaining = Math.max(0, this.statusBarPlannedSec - elapsed);
      if (remaining <= 0) {
        // 休息结束（自动结束，保持状态同步）
        this.stopRest();
        return;
      }
      const lang = getLanguage();
      this.statusBarEl.setText(`⏱️ ${lang === 'zh' ? '休息' : 'Rest'} ${formatTime(remaining)}`);
      return;
    }
    
    // 正计时模式（plannedSec为null）：实时显示已用时间
    if (this.statusBarStartTime && this.statusBarPlannedSec === null) {
      // 正计时模式：检查是否达到600分钟（10小时）
      const now = Date.now();
      const elapsed = Math.floor((now - this.statusBarStartTime) / 1000);
      const elapsedMinutes = elapsed / 60;
      
      if (elapsedMinutes >= 600) {
        // 达到600分钟，自动完成
        this.timerManager.clear("status-bar");
        new Notice(t("stopwatchOver10Hours"), 5000);
        this.stopFocus("completed");
        return;
      }
      // 正计时时实时显示
      this.statusBarEl.setText(`⏱️ ${formatTime(elapsed)}`);
      return;
    }
    
    if (this.statusBarStartTime && this.statusBarPlannedSec !== null) {
      const now = Date.now();
      const elapsed = Math.floor((now - this.statusBarStartTime) / 1000);
      // 开关关闭时：倒计时结束时自动完成
      if (elapsed >= this.statusBarPlannedSec && !this.settings.autoContinue) {
        this.timerManager.clear("status-bar");
        this.stopFocus("completed");
        return;
      }
      this.statusBarEl.setText(`⏱️ ${formatTime(elapsed)} / ${formatTime(this.statusBarPlannedSec)}`);
    }
  }

  // 启动状态栏计时器（每秒更新文本，使用统一定时器管理器）
  startStatusBarTimer() {
    this.timerManager.clear("status-bar");
    this.timerManager.setInterval("status-bar", 1000, () => this.updateStatusBarText());
    this.updateStatusBarText();
  }

  // 停止状态栏计时器
  stopStatusBarTimer() {
    this.timerManager.clear("status-bar");
  }

  async startFocus(plannedSec, mode = null, note = "") {
    // 检查是否已经有正在执行的番茄
    const state = await readState(this.app);
    if (state.active && !state.resting) {
      new Notice(t("focusStartFailed"));
      return;
    }
    
    // 限制专注事项：英文字符最多40个
    const trimmedNote = (note || "").trim();
    const finalNote = limitInputLength(trimmedNote);
    
    if (finalNote) {
      let list = this.settings.suggestTasks || [];
      if (!Array.isArray(list)) this.settings.suggestTasks = [];
      list = this.settings.suggestTasks;
      const idx = list.indexOf(finalNote);
      if (idx !== -1) {
        list.splice(idx, 1);
      } else if (list.length >= MAX_SUGGEST_TASKS) {
        list.pop();
      }
      list.unshift(finalNote);
      this.settings.suggestTasks = list.slice(0, MAX_SUGGEST_TASKS);
      await this.saveSettings();
    }
    
    const s = nowISO();
    // mode: "countdown" 或 "stopwatch"，如果为null则使用设置中的默认模式
    const timerMode = mode || this.settings.defaultMode;
    const isStopwatch = timerMode === "stopwatch";

    // 正计时模式：plannedSec为null
    const end = isStopwatch ? null : new Date(Date.now() + plannedSec * 1000).toISOString();
    const actualPlannedSec = isStopwatch ? null : plannedSec;

    await writeState(this.app, {
      active: true,
      start: s,
      end,
      plannedSec: actualPlannedSec,
      mode: timerMode,
      note: finalNote
    });

    if (isStopwatch) {
      new Notice(t("stopwatchStarted"));
    } else {
      const minutes = Math.round(plannedSec/60);
      new Notice(t("focusStarted").replace("{minutes}", minutes));
    }
    this.updateStatusBarDisplay(); // 更新本地计时器数据
    this.updateView(); // 更新视图（只在状态改变时）
  }

  async stopFocus(status) {
    const state = await readState(this.app);
    if (!state.active || state.resting) {
      new Notice(t("focusStopFailed"));
      return; // 已结束或正在休息（如倒计时自动完成时可能被重复调用）
    }
    // 若以「完成」结束且当前是倒计时且不允许提前完成，则拒绝（超时后允许完成）
    if (status === "completed" && this.settings.allowCompleteCountdownEarly !== true) {
      const isCountdown = state.mode === "countdown" || state.plannedSec != null;
      const elapsedSec = Math.floor(clamp0(msBetween(state.start, nowISO())) / 1000);
      const isOvertime = state.plannedSec != null && elapsedSec >= state.plannedSec;
      if (isCountdown && !isOvertime) {
        new Notice(t("completeCountdownEarlyDisabled"));
        return;
      }
    }

    const end = nowISO();
    const actualSec = Math.floor(clamp0(msBetween(state.start, end)) / 1000);

    const session = {
      id: state.start,
      start: state.start,
      end,
      plannedSec: state.plannedSec ?? null,
      actualSec,
      status,
      note: state.note ?? "",
      createdAt: nowISO()
    };

    await appendSession(this.app, session);
    
    // 停止提醒（Obsidian 内）
    const mins = Math.round(actualSec / 60);
    const statusText = status === "completed" ? t("completedStatus") : t("abandonedStatus");
    new Notice(t("focusEnded").replace("{status}", statusText).replace("{minutes}", mins));

    // 如果设置为自动休息且状态为完成，则自动进入休息
    if (status === "completed" && this.settings.autoRest === true) {
      await this.startRest();
    } else {
      await writeState(this.app, { active: false, resting: false });
      this.updateStatusBarDisplay(); // 更新本地计时器数据
      this.updateView(); // 更新视图（只在状态改变时）
    }

    // 可选：把记录写入当天 Daily Note 的某个标题（需要你有固定 daily note 路径/命名）
    // 这里先不强绑，避免你说的“强行联系在一起”
  }

  // 开始休息
  async startRest(restMinutes = null) {
    const restSec = (restMinutes || this.settings.defaultRestMinutes || 5) * 60;
    const restEnd = new Date(Date.now() + restSec * 1000).toISOString();
    
    await writeState(this.app, {
      active: false,
      resting: true,
      restStart: nowISO(),
      restEnd,
      restSec
    });

    const restMinutesDisplay = Math.round(restSec/60);
    new Notice(t("restStarted").replace("{minutes}", restMinutesDisplay));
    this.updateStatusBarDisplay();
    this.updateView();
  }

  // 结束休息
  async stopRest() {
    const state = await readState(this.app);
    if (!state.resting) {
      return;
    }

    await writeState(this.app, { active: false, resting: false });
    new Notice(t("restEnded"));
    this.updateStatusBarDisplay();
    this.updateView();
  }

  async moveSuggestToFront(text) {
    if (!text || !text.trim()) return;
    let list = this.settings.suggestTasks || [];
    if (!Array.isArray(list)) this.settings.suggestTasks = [];
    list = [...this.settings.suggestTasks];
    const idx = list.indexOf(text.trim());
    if (idx !== -1) list.splice(idx, 1);
    list.unshift(text.trim());
    this.settings.suggestTasks = list.slice(0, MAX_SUGGEST_TASKS);
    await this.saveSettings();
  }

  updateView() {
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE);
    leaves.forEach(leaf => {
      if (leaf.view instanceof FocusTimerView) {
        leaf.view.render(); // 只在状态改变时重新渲染
        leaf.view.startTimer(); // 重启计时器
      }
    });
  }

  async loadSettings() {
    try {
      const settings = await readSettings(this.app);
      const defaultSettings = {
        autoContinue: false,
        defaultMode: "countdown",
        adjustStepMinutes: 5,
        defaultDurationMinutes: 25,
        quickTimer1: { name: "", minutes: 25 },
        quickTimer2: { name: "", minutes: 25 },
        quickTimer3: { name: "", minutes: 25 },
        autoRest: false,
        defaultRestMinutes: 5,
        keyboardShortcuts: false,
        statusBarShowFocus: true,
        allowCompleteCountdownEarly: false,
        suggestTasks: [],
        codeBlockChartShowTime: true,
        codeBlockChartShowCount: true
      };
      const mergedSettings = { ...defaultSettings, ...settings };
      this.settings = { ...this.settings, ...mergedSettings };
      if (this.settings.keyboardShortcuts === undefined) this.settings.keyboardShortcuts = false;
      if (this.settings.statusBarShowFocus === undefined) this.settings.statusBarShowFocus = true;
      if (this.settings.allowCompleteCountdownEarly === undefined) this.settings.allowCompleteCountdownEarly = false;
      if (!Array.isArray(this.settings.suggestTasks)) this.settings.suggestTasks = [];
      this.settings.suggestTasks = this.settings.suggestTasks.slice(0, MAX_SUGGEST_TASKS);
      if (this.settings.codeBlockChartShowTime === undefined) this.settings.codeBlockChartShowTime = true;
      if (this.settings.codeBlockChartShowCount === undefined) this.settings.codeBlockChartShowCount = true;
      // 确保defaultDurationMinutes是有效的整数
      if (!this.settings.defaultDurationMinutes || isNaN(this.settings.defaultDurationMinutes) || this.settings.defaultDurationMinutes <= 0) {
        this.settings.defaultDurationMinutes = 25;
      }
      // 确保adjustStepMinutes在1-60之间的整数
      if (!this.settings.adjustStepMinutes || isNaN(this.settings.adjustStepMinutes) || this.settings.adjustStepMinutes < 1 || this.settings.adjustStepMinutes > 60) {
        this.settings.adjustStepMinutes = 5;
      } else {
        this.settings.adjustStepMinutes = Math.min(Math.max(Math.floor(this.settings.adjustStepMinutes), 1), 60);
      }
      // 确保快捷timer设置存在
      if (!this.settings.quickTimer1) this.settings.quickTimer1 = { name: "", minutes: 25 };
      if (!this.settings.quickTimer2) this.settings.quickTimer2 = { name: "", minutes: 25 };
      if (!this.settings.quickTimer3) this.settings.quickTimer3 = { name: "", minutes: 25 };
      // 确保名称长度符合限制：英文字符最多40个
      if (this.settings.quickTimer1.name) {
        this.settings.quickTimer1.name = limitInputLength(this.settings.quickTimer1.name);
      }
      if (this.settings.quickTimer2.name) {
        this.settings.quickTimer2.name = limitInputLength(this.settings.quickTimer2.name);
      }
      if (this.settings.quickTimer3.name) {
        this.settings.quickTimer3.name = limitInputLength(this.settings.quickTimer3.name);
      }
      // 确保休息设置存在
      if (this.settings.autoRest === undefined) this.settings.autoRest = false;
      if (!this.settings.defaultRestMinutes || isNaN(this.settings.defaultRestMinutes) || this.settings.defaultRestMinutes <= 0) {
        this.settings.defaultRestMinutes = 5;
      }
    } catch (error) {
      // 忽略设置加载错误
    }
  }

  async saveSettings() {
    try {
      await writeSettings(this.app, this.settings);
      // 更新快捷 timer 命令名称
      this.registerQuickTimerCommands();
    } catch (error) {
      // 忽略设置保存错误
    }
  }

  // 注册或更新快捷Timer命令
  registerQuickTimerCommands() {
    // 生成命令名称的辅助函数
    const getCommandName = (timerNum, timer) => {
      const timerName = timer && timer.name && timer.name.trim() ? timer.name.trim() : "";
      if (timerName) {
        return `timer ${timerNum} ${timerName}`;
      }
      return `timer ${timerNum}`;
    };

    // 注册快捷Timer 1命令（重新注册会覆盖旧命令）
    const timer1 = this.settings.quickTimer1;
    if (timer1 && timer1.name && timer1.name.trim()) {
      this.addCommand({
        id: "focus-quick-timer-1",
        name: getCommandName(1, timer1),
        checkCallback: (checking) => {
          const timer = this.settings.quickTimer1;
          const valid = !!(timer && timer.name && timer.name.trim());
          if (valid && !checking) {
            const minutes = timer.minutes || 25;
            this.startFocus(minutes * 60, "countdown", timer.name.trim());
          }
          return valid;
        },
      });
    }

    // 注册快捷Timer 2命令（重新注册会覆盖旧命令）
    const timer2 = this.settings.quickTimer2;
    if (timer2 && timer2.name && timer2.name.trim()) {
      this.addCommand({
        id: "focus-quick-timer-2",
        name: getCommandName(2, timer2),
        checkCallback: (checking) => {
          const timer = this.settings.quickTimer2;
          const valid = !!(timer && timer.name && timer.name.trim());
          if (valid && !checking) {
            const minutes = timer.minutes || 25;
            this.startFocus(minutes * 60, "countdown", timer.name.trim());
          }
          return valid;
        },
      });
    }

    // 注册快捷Timer 3命令（重新注册会覆盖旧命令）
    const timer3 = this.settings.quickTimer3;
    if (timer3 && timer3.name && timer3.name.trim()) {
      this.addCommand({
        id: "focus-quick-timer-3",
        name: getCommandName(3, timer3),
        checkCallback: (checking) => {
          const timer = this.settings.quickTimer3;
          const valid = !!(timer && timer.name && timer.name.trim());
          if (valid && !checking) {
            const minutes = timer.minutes || 25;
            this.startFocus(minutes * 60, "countdown", timer.name.trim());
          }
          return valid;
        },
      });
    }
  }

  // 为代码块创建统计卡片的辅助方法（使用标准DOM API）
  createStatCardForCodeBlock(container, title, mainValue, comparison, average) {
    const card = document.createElement('div');
    card.className = 'focus-stat-card';
    
    const titleEl = document.createElement('div');
    titleEl.className = 'focus-stat-card-title';
    titleEl.textContent = title;
    card.appendChild(titleEl);
    
    const mainValueRow = document.createElement('div');
    mainValueRow.className = 'focus-stat-main-row';
    const mainValueEl = document.createElement('div');
    mainValueEl.className = 'focus-stat-main-value';
    
    // 如果mainValue是对象（包含数字和单位），分开显示
    if (typeof mainValue === 'object' && mainValue.number) {
      const numberSpan = document.createElement('span');
      numberSpan.className = 'focus-stat-number';
      numberSpan.textContent = mainValue.number;
      mainValueEl.appendChild(numberSpan);
      if (mainValue.unit) {
        const unitSpan = document.createElement('span');
        unitSpan.className = 'focus-stat-unit';
        unitSpan.textContent = mainValue.unit;
        mainValueEl.appendChild(unitSpan);
      }
      if (mainValue.number2) {
        const number2Span = document.createElement('span');
        number2Span.className = 'focus-stat-number';
        number2Span.textContent = mainValue.number2;
        mainValueEl.appendChild(number2Span);
      }
      if (mainValue.unit2) {
        const unit2Span = document.createElement('span');
        unit2Span.className = 'focus-stat-unit';
        unit2Span.textContent = mainValue.unit2;
        mainValueEl.appendChild(unit2Span);
      }
    } else {
      // 处理"X 个任务"这种格式
      const parts = String(mainValue).split(/(\d+)/);
      parts.forEach(part => {
        if (part && !isNaN(part)) {
          const numberSpan = document.createElement('span');
          numberSpan.className = 'focus-stat-number';
          numberSpan.textContent = part;
          mainValueEl.appendChild(numberSpan);
        } else if (part) {
          const unitSpan = document.createElement('span');
          unitSpan.className = 'focus-stat-unit';
          unitSpan.textContent = part;
          mainValueEl.appendChild(unitSpan);
        }
      });
    }
    
    mainValueRow.appendChild(mainValueEl);
    
    // 对比数据（放在右侧，标签在上一行，值在下一行）
    if (comparison) {
      // 支持"昨天"、"前一天"、"前天"、"上月"以及对应的英文标签
      // 注意：标签和符号之间可能有空格
      const lang = getLanguage();
      let comparisonMatch;
      if (lang === 'zh') {
        comparisonMatch = comparison.match(/(昨天|前一天|前天|上月)\s*([+-])([\d.]+.*)/);
      } else {
        // 英文标签：Yesterday, Previous Day, Last Month
        comparisonMatch = comparison.match(/(Yesterday|Previous Day|Last Month)\s*([+-])([\d.]+.*)/);
      }
      if (comparisonMatch) {
        const label = comparisonMatch[1];
        const sign = comparisonMatch[2];
        const value = comparisonMatch[3];
        const isPositive = sign === '+';
        
        const comparisonEl = document.createElement('div');
        comparisonEl.className = `focus-stat-comparison ${isPositive ? 'comparison-positive' : 'comparison-negative'}`;
        
        const labelEl = document.createElement('div');
        labelEl.className = 'comparison-label';
        labelEl.textContent = label;
        comparisonEl.appendChild(labelEl);
        
        const valueEl = document.createElement('div');
        valueEl.className = 'comparison-value';
        valueEl.textContent = `${sign}${value}`;
        comparisonEl.appendChild(valueEl);
        
        mainValueRow.appendChild(comparisonEl);
      } else {
        const comparisonEl = document.createElement('div');
        comparisonEl.className = 'focus-stat-comparison';
        comparisonEl.textContent = comparison;
        mainValueRow.appendChild(comparisonEl);
      }
    }
    
    card.appendChild(mainValueRow);
    
    // 平均值（单独一行）
    if (average) {
      // 检查是否是"全年累计完成"，如果是则添加额外的类
      const isYearlyTotal = average.includes(t("yearlyTotalCompleted")) || average.includes("全年累计完成");
      const averageClasses = isYearlyTotal ? "focus-stat-average focus-stat-average-yearly" : "focus-stat-average";
      const averageEl = document.createElement('div');
      averageEl.className = averageClasses;
      averageEl.textContent = average;
      card.appendChild(averageEl);
    }
    
    container.appendChild(card);
  }

  // 设置每天0:00自动刷新（使用统一定时器管理器）
  setupDailyRefresh(el, ctx, showRecord = true, showItems = true, height = null, chartRange = null, chartMetric = null) {
    if (!el._focusDailyRefreshId) {
      this._dailyRefreshCounter = (this._dailyRefreshCounter ?? 0) + 1;
      el._focusDailyRefreshId = "daily-refresh-" + this._dailyRefreshCounter;
    }
    const id = el._focusDailyRefreshId;
    this.timerManager.clear(id);

    const now = new Date();
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(0, 0, 0, 0);
    const msUntilMidnight = tomorrow.getTime() - now.getTime();

    this.timerManager.setTimeout(id, msUntilMidnight, async () => {
      const todayKey = getDateKey(new Date());
      const storedHeight = el._focusBlockHeight || height;
      await this.renderFocusBlock(el, ctx, todayKey, true, showRecord, showItems, storedHeight, chartRange, chartMetric);
      this.setupDailyRefresh(el, ctx, showRecord, showItems, storedHeight, chartRange, chartMetric);
    });
  }

  async renderFocusBlock(el, ctx, targetDate = null, isToday = false, showRecord = true, showItems = true, height = null, chartRange = null, chartMetric = null) {
    try {
      // 清空容器 - 使用安全的 DOM API
      while (el.firstChild) {
        el.removeChild(el.firstChild);
      }
      el.className = 'focus-code-block';

      // 把当前 chart 配置挂在元素上，供刷新按钮复用
      el._chartRange = chartRange;
      el._chartMetric = chartMetric;
      
      // 如果指定了高度，应用到容器
      if (height !== null && height > 0) {
        el.style.setProperty('--focus-block-height', height + 'px');
        el.classList.add('focus-code-block-with-height');
        // 存储高度值，供后续刷新使用
        el._focusBlockHeight = height;
      } else {
        el.style.removeProperty('--focus-block-height');
        el.classList.remove('focus-code-block-with-height');
        el._focusBlockHeight = null;
      }
      
      // 读取数据
      let sessions = await readSessions(this.app);
      
      // 如果指定了日期，过滤该日期的数据
      let dateSessions = sessions;
      let baseDateForStats = null;
      if (targetDate) {
        // 解析targetDate为本地日期，避免时区问题
        // targetDate格式是 YYYY-MM-DD，需要解析为本地日期
        const [year, month, day] = targetDate.split('-').map(Number);
        const targetDateObj = new Date(year, month - 1, day); // 月份从0开始，本地时间
        // 使用本地日期生成日期键，确保一致性
        const targetDateKey = getDateKey(targetDateObj);
        // 过滤记录时，确保使用相同的日期键生成方式
        dateSessions = sessions.filter(s => {
          const sessionDate = new Date(s.start);
          const sessionDateKey = getDateKey(sessionDate);
          return sessionDateKey === targetDateKey;
        });
        // 使用该日期作为基准日期来计算统计（包括前一天、7天平均等）
        // 使用本地日期字符串，格式为 YYYY-MM-DD
        const localDateStr = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        baseDateForStats = localDateStr;
      }
      
      // 使用所有sessions计算统计，但基于指定日期
      const stats = calculateStats(sessions, baseDateForStats);
      
      // 创建统计区域（仅在showRecord为true时）
      if (showRecord) {
        const statsSection = document.createElement('div');
        statsSection.className = 'focus-code-stats-section';
        
        // 如果设置了高度，statsSection不应该收缩
        if (height !== null && height > 0) {
          statsSection.classList.add('focus-code-stats-section-no-shrink');
        }
        
        const statsHeader = document.createElement('div');
        statsHeader.className = 'focus-code-stats-header';
        
        const title = document.createElement('h3');
        title.className = 'focus-code-stats-title';
        title.textContent = t("focusHistory");
        statsHeader.appendChild(title);
        
        // 刷新按钮
        const refreshBtn = document.createElement('button');
        refreshBtn.className = 'focus-code-refresh-btn';
        refreshBtn.setAttribute('aria-label', '刷新数据');
        refreshBtn.textContent = '↻';
        refreshBtn.title = '刷新数据';
        refreshBtn.addEventListener('click', async (e) => {
          e.preventDefault();
          refreshBtn.disabled = true;
          refreshBtn.classList.add('focus-code-refresh-spin');
          try {
            await this.renderFocusBlock(el, ctx, targetDate, isToday, showRecord, showItems, height, el._chartRange, el._chartMetric);
          } finally {
            refreshBtn.disabled = false;
            refreshBtn.classList.remove('focus-code-refresh-spin');
          }
        });
        statsHeader.appendChild(refreshBtn);
        
        statsSection.appendChild(statsHeader);
        
        // 2×2网格统计卡片
        const statsGrid = document.createElement('div');
        statsGrid.className = 'focus-code-stats-grid';
        
        // 使用专门的方法创建卡片
        // 根据是否指定日期，使用不同的标题和对比文本
        let focusTitle, completedTitle, comparisonLabel;
        // 检查是否是昨天（通过比较targetDate和昨天的日期）
        const yesterday = new Date();
        yesterday.setDate(yesterday.getDate() - 1);
        const yesterdayKey = getDateKey(yesterday);
        const isYesterday = targetDate === yesterdayKey;
        
        const lang = getLanguage();
        if (isToday) {
          // date:today 时显示"今天专注"、"今天完成"、"昨天"
          focusTitle = t("todayFocusAlt");
          completedTitle = t("todayCompletedAlt");
          comparisonLabel = t("yesterday");
        } else if (isYesterday) {
          // date:yesterday 时显示"昨天专注"、"昨天完成"、"前天"
          focusTitle = t("yesterdayFocus");
          completedTitle = t("yesterdayCompleted");
          comparisonLabel = t("dayBeforeYesterday");
        } else if (targetDate) {
          // 指定具体日期时显示"当天专注"、"当天完成"、"前一天"
          focusTitle = t("dayFocus");
          completedTitle = t("dayCompleted");
          comparisonLabel = t("dayBefore");
        } else {
          // 未指定日期时显示"今日专注"、"今日完成"、"昨天"
          focusTitle = t("todayFocus");
          completedTitle = t("todayCompleted");
          comparisonLabel = t("yesterday");
        }
        
        // 今日专注/当天专注/今天专注
        this.createStatCardForCodeBlock(statsGrid, focusTitle, 
          formatTimeChinese(stats.today),
          `${comparisonLabel} ${stats.yesterdayDiff >= 0 ? '+' : '-'}${formatTimeShort(Math.abs(stats.yesterdayDiff))}`,
          `${t("avg7Days")} ${formatTimeShort(stats.avg7Days)}`);
        
        // 今日完成/当天完成/今天完成
        this.createStatCardForCodeBlock(statsGrid, completedTitle,
          `${stats.todayCompleted} ${t("tasks")}`,
          `${comparisonLabel} ${stats.yesterdayCompletedDiff >= 0 ? '+' : '-'}${Math.abs(stats.yesterdayCompletedDiff)}`,
          `${t("avg7Days")} ${stats.avg7DaysCompleted.toFixed(1)} ${t("tasks")}`);
        
        // 如果未指定日期，显示本月平均和全年总专注
        if (!targetDate) {
          // 本月平均专注
          this.createStatCardForCodeBlock(statsGrid, t("monthlyAvgFocus"),
            formatTimeChinese(stats.avgCurrentMonth),
            `${t("lastMonth")} ${stats.monthDiff >= 0 ? '+' : '-'}${formatTimeShort(Math.abs(stats.monthDiff))}`,
            `${t("monthlyAvg")} ${stats.avgCurrentMonthCompleted.toFixed(1)} ${t("tasks")}`);
          
          // 全年总专注
          this.createStatCardForCodeBlock(statsGrid, t("yearlyTotalFocus"),
            formatTimeChinese(stats.yearTotal),
            null, // 不显示对比数据
            `${t("yearlyTotalCompleted")} ${stats.yearCompleted} ${t("tasks")}`);
        }
        
        statsSection.appendChild(statsGrid);
        el.appendChild(statsSection);
      }
      
      // 如果指定了日期且showItems为true，显示该日期的所有专注记录
      if (targetDate && showItems) {
        const historySection = document.createElement('div');
        historySection.className = 'focus-code-history-section';
        
        // 如果设置了高度，让historySection使用flex布局以便historyContent可以滚动
        if (height !== null && height > 0) {
          historySection.classList.add('focus-code-history-section-with-height');
        }
        
        const historyHeader = document.createElement('div');
        historyHeader.className = 'focus-code-history-header';
        
        const historyTitle = document.createElement('h3');
        historyTitle.className = 'focus-code-history-title';
        historyTitle.textContent = t("dayFocus");
        historyHeader.appendChild(historyTitle);
        
        // 仅当不显示专注记录时，在此处显示刷新按钮（否则已在专注记录标题旁显示）
        if (!showRecord) {
          const refreshBtnHistory = document.createElement('button');
          refreshBtnHistory.className = 'focus-code-refresh-btn';
          refreshBtnHistory.setAttribute('aria-label', '刷新数据');
          refreshBtnHistory.textContent = '↻';
          refreshBtnHistory.title = '刷新数据';
          refreshBtnHistory.addEventListener('click', async (e) => {
            e.preventDefault();
            refreshBtnHistory.disabled = true;
            refreshBtnHistory.classList.add('focus-code-refresh-spin');
            try {
              await this.renderFocusBlock(el, ctx, targetDate, isToday, showRecord, showItems, height, el._chartRange, el._chartMetric);
            } finally {
              refreshBtnHistory.disabled = false;
              refreshBtnHistory.classList.remove('focus-code-refresh-spin');
            }
          });
          historyHeader.appendChild(refreshBtnHistory);
        }
        
        historySection.appendChild(historyHeader);
        
        const historyContent = document.createElement('div');
        historyContent.className = 'focus-code-history-content';
        
        // 如果设置了高度，让historyContent可滚动
        if (height !== null && height > 0) {
          historyContent.classList.add('focus-code-history-content-scrollable');
        }
        
        // 按时间排序（倒序，最新的在上面）
        const sortedSessions = [...dateSessions].sort((a, b) => {
          return new Date(b.start).getTime() - new Date(a.start).getTime();
        });
        
        if (sortedSessions.length === 0) {
          const emptyMsg = document.createElement('div');
          emptyMsg.className = 'focus-code-history-empty';
          emptyMsg.textContent = t("noFocusRecordsToday");
          historyContent.appendChild(emptyMsg);
        } else {
          sortedSessions.forEach(session => {
            const item = document.createElement('div');
            item.className = 'focus-code-history-item';
            
            const time = new Date(session.start);
            const timeStr = `${String(time.getHours()).padStart(2, '0')}:${String(time.getMinutes()).padStart(2, '0')}`;
            
            // 显示专注事项名称，如果没有则显示默认文本
            const noteText = session.note && session.note.trim() 
              ? session.note.trim() 
              : t("oneTask");
            
            let entryText = "";
            if (session.status === "completed") {
              // 完成了（一个任务/任务名），26分钟
              const lang = getLanguage();
              entryText = lang === 'zh' 
                ? `${timeStr} ${t("completed")} ${noteText}，${formatTimeShort(session.actualSec)}`
                : `${timeStr} ${t("completed")} ${noteText}, ${formatTimeShort(session.actualSec)}`;
            } else {
              // 放弃了（一个任务/任务名）
              entryText = `${timeStr} ${t("abandoned")} ${noteText}`;
            }
            
            const entry = document.createElement('div');
            entry.className = `focus-code-history-entry ${session.status === "completed" ? "status-completed" : "status-abandoned"}`;
            entry.textContent = entryText;
            
            item.appendChild(entry);
            historyContent.appendChild(item);
          });
        }
        
        historySection.appendChild(historyContent);
        el.appendChild(historySection);
      } else if (!targetDate && showItems && chartRange !== "none") {
        // 未指定日期且showItems为true，并且 chartRange 不是 none 时，显示图表
        const chartContainer = document.createElement('div');
        chartContainer.className = 'focus-code-chart';
        
        // 计算图表范围标签和用于计算数据的范围值（统一走 chartRangeToLabelAndCalculation）
        const shortKey = CHART_RANGE_CONFIG.some(c => c.shortKey === chartRange) ? chartRange : defaultChartRangeToShortKey(this.settings.defaultChartRange);
        const { rangeLabel, rangeForCalculation } = chartRangeToLabelAndCalculation(shortKey);

        const chartHeader = document.createElement('div');
        chartHeader.className = 'focus-code-chart-header';
        
        const chartTitle = document.createElement('h3');
        chartTitle.className = 'focus-code-chart-title';
        const lang = getLanguage();
        chartTitle.textContent = lang === 'zh' ? `${t("focusTrend")}（${rangeLabel}）` : `${t("focusTrend")} (${rangeLabel})`;
        chartHeader.appendChild(chartTitle);
        
        const refreshBtnChart = document.createElement('button');
        refreshBtnChart.className = 'focus-code-refresh-btn';
        refreshBtnChart.setAttribute('aria-label', '刷新数据');
        refreshBtnChart.textContent = '↻';
        refreshBtnChart.title = '刷新数据';
        refreshBtnChart.addEventListener('click', async (e) => {
          e.preventDefault();
          refreshBtnChart.disabled = true;
          refreshBtnChart.classList.add('focus-code-refresh-spin');
          try {
            await this.renderFocusBlock(el, ctx, targetDate, isToday, showRecord, showItems, height, el._chartRange, el._chartMetric);
          } finally {
            refreshBtnChart.disabled = false;
            refreshBtnChart.classList.remove('focus-code-refresh-spin');
          }
        });
        chartHeader.appendChild(refreshBtnChart);
        
        chartContainer.appendChild(chartHeader);
        
        const chartCanvasContainer = document.createElement('div');
        chartCanvasContainer.className = 'focus-code-chart-canvas';
        chartContainer.appendChild(chartCanvasContainer);
        
        el.appendChild(chartContainer);
        
        // 计算指定范围的图表数据（使用中文格式的范围值）
        const chartData = calculateChartData(sessions, rangeForCalculation);
        
        // 创建图表（使用共享 createLineChart 函数，代码块为静态无 tooltip）
        if (chartData && chartData.length > 0) {
          let showTime = this.settings.codeBlockChartShowTime ?? true;
          let showCount = this.settings.codeBlockChartShowCount ?? true;
          if (chartMetric === "time") {
            showTime = true;
            showCount = false;
          } else if (chartMetric === "task") {
            showTime = false;
            showCount = true;
          }
          createLineChart(chartCanvasContainer, chartData, { showTime, showCount, interactive: false });
        } else {
          const emptyMsg = document.createElement('div');
          emptyMsg.className = 'focus-code-history-empty';
          emptyMsg.textContent = t("noData");
          chartCanvasContainer.appendChild(emptyMsg);
        }
      }
    } catch (error) {
      const errorDiv = document.createElement('div');
      errorDiv.className = 'focus-code-error';
      errorDiv.textContent = `错误: ${error.message}`;
      el.appendChild(errorDiv);
    }
  }

  onunload() {
    if (this._keydownHandler) {
      document.removeEventListener("keydown", this._keydownHandler);
      this._keydownHandler = null;
    }
    this.timerManager.clearAll();
    if (this.styleEl && this.styleEl.parentNode) {
      this.styleEl.parentNode.removeChild(this.styleEl);
    }
  }
};
