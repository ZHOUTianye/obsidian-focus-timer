const obsidian = require("obsidian");
const { Plugin, Notice, MarkdownPostProcessor } = obsidian;
const { TimerManager } = require("./core.js");
const { VIEW_TYPE, MAX_SUGGEST_TASKS, nowISO, clamp0 } = require("./constants.js");
const { getLanguage, resetLanguageCache, t } = require("./i18n.js");
const { ensureDataFileExists, readState, readSessions, writeState, appendSession, readSettings, writeSettings } = require("./data.js");
const { msBetween, formatTime, getDateKey, formatTimeChinese, formatTimeShort } = require("./format.js");
const { defaultChartRangeToShortKey, chartRangeToLabelAndCalculation, calculateChartData, createLineChart, CHART_RANGE_CONFIG } = require("./chart.js");
const { calculateStats } = require("./stats.js");
const { FocusTimerView } = require("./view.js");
const { FocusTimerSettingTab } = require("./settings-tab.js");
const { limitInputLength } = require("./utils.js");

module.exports = class FocusTimerPlugin extends Plugin {
  statusBarEl = null;
  timerManager = new TimerManager();
  statusBarStartTime = null; // 本地记录的开始时间
  statusBarPlannedSec = null; // 计划时长
  statusBarMode = null; // "focus" | "rest" | null
  _timerActive = false;
  _timerResting = false;
  _tickActive = false;
  _tickRunning = false;
  _autoStopInFlight = false;
  _tickTimerId = "focus-tick";
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
    await this.syncLocalTimerState();

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
      let showRecord = true; // 默认显示专注数据
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
        el.className = 'focus-timer-plugin-code-block';
        const errorDiv = document.createElement('div');
        errorDiv.className = 'focus-timer-plugin-code-error';
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
      this.statusBarEl.addClass("focus-timer-plugin-timer-statusbar");
      this.statusBarEl.onClickEvent(() => this.openView());
      this.updateStatusBarDisplay();
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
  async syncLocalTimerState() {
    const state = await readState(this.app);

    if (state.active && !state.resting) {
      // 保存开始时间和计划时长，用于本地计时
      this.statusBarStartTime = state.start ? new Date(state.start).getTime() : null;
      this.statusBarPlannedSec = state.plannedSec ?? null;
      this.statusBarMode = "focus";
      this._timerActive = true;
      this._timerResting = false;
    } else if (state.resting) {
      // 休息状态
      this.statusBarStartTime = state.restStart ? new Date(state.restStart).getTime() : Date.now();
      this.statusBarPlannedSec = typeof state.restSec === "number" ? state.restSec : 0;
      this.statusBarMode = "rest";
      this._timerActive = false;
      this._timerResting = true;
    } else {
      // 清除计时器数据
      this.statusBarStartTime = null;
      this.statusBarPlannedSec = null;
      this.statusBarMode = null;
      this._timerActive = false;
      this._timerResting = false;
    }

    this.updateTickingState();
    return state;
  }

  async updateStatusBarDisplay() {
    const state = await this.syncLocalTimerState();
    if (!this.statusBarEl) return;
    
    if (state.active && !state.resting) {
      this.statusBarEl.addClass("focus-timer-plugin-timer-active");
      // 立即刷新一次文本（正计时/倒计时都实时显示）
      this.updateStatusBarText();
    } else if (state.resting) {
      this.statusBarEl.removeClass("focus-timer-plugin-timer-active");
      this.updateStatusBarText();
    } else {
      this.statusBarEl.removeClass("focus-timer-plugin-timer-active");
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
      const lang = getLanguage();
      this.statusBarEl.setText(`⏱️ ${lang === 'zh' ? '休息' : 'Rest'} ${formatTime(remaining)}`);
      return;
    }
    
    // 正计时模式（plannedSec为null）：实时显示已用时间
    if (this.statusBarStartTime && this.statusBarPlannedSec === null) {
      const now = Date.now();
      const elapsed = Math.floor((now - this.statusBarStartTime) / 1000);
      // 正计时时实时显示
      this.statusBarEl.setText(`⏱️ ${formatTime(elapsed)}`);
      return;
    }
    
    if (this.statusBarStartTime && this.statusBarPlannedSec !== null) {
      const now = Date.now();
      const elapsed = Math.floor((now - this.statusBarStartTime) / 1000);
      this.statusBarEl.setText(`⏱️ ${formatTime(elapsed)} / ${formatTime(this.statusBarPlannedSec)}`);
    }
  }

  updateTickingState() {
    const shouldRun = this._timerActive || this._timerResting;
    if (shouldRun) {
      this.startUnifiedTimer();
    } else {
      this.stopUnifiedTimer();
    }
  }

  // 启动统一计时器（面板与状态栏共用）
  startUnifiedTimer() {
    if (this._tickActive) return;
    this._tickActive = true;
    this.timerManager.clear(this._tickTimerId);
    this.timerManager.setInterval(this._tickTimerId, 1000, () => this.tick());
    if (!this._tickRunning) {
      this.tick();
    }
  }

  stopUnifiedTimer() {
    if (!this._tickActive) return;
    this._tickActive = false;
    this.timerManager.clear(this._tickTimerId);
  }

  async tick() {
    if (this._tickRunning) return;
    this._tickRunning = true;
    try {
      await this.handleAutoStop();
      this.updateStatusBarText();
      this.updateOpenViewsTimerDisplay();
    } finally {
      this._tickRunning = false;
    }
  }

  async handleAutoStop() {
    if (this._autoStopInFlight) return;
    if (!this.statusBarStartTime || !this.statusBarMode) return;

    const now = Date.now();
    const elapsed = Math.floor((now - this.statusBarStartTime) / 1000);

    if (this.statusBarMode === "rest") {
      if (this.statusBarPlannedSec != null && elapsed >= this.statusBarPlannedSec) {
        this._autoStopInFlight = true;
        await this.stopRest();
        this._autoStopInFlight = false;
      }
      return;
    }

    if (this.statusBarMode === "focus") {
      // 正计时：到 10 小时自动完成
      if (this.statusBarPlannedSec === null) {
        if (elapsed >= 600 * 60) {
          this._autoStopInFlight = true;
          new Notice(t("stopwatchOver10Hours"), 5000);
          await this.stopFocus("completed");
          this._autoStopInFlight = false;
        }
        return;
      }

      // 倒计时：未开启自动继续时到点完成
      if (elapsed >= this.statusBarPlannedSec && !this.settings.autoContinue) {
        this._autoStopInFlight = true;
        await this.stopFocus("completed");
        this._autoStopInFlight = false;
      }
    }
  }

  updateOpenViewsTimerDisplay() {
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE);
    leaves.forEach(leaf => {
      if (leaf.view instanceof FocusTimerView) {
        leaf.view.updateTimerDisplay();
      }
    });
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
    await this.updateStatusBarDisplay(); // 更新本地计时器数据
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
      await this.updateStatusBarDisplay(); // 更新本地计时器数据
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
    await this.updateStatusBarDisplay();
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
    await this.updateStatusBarDisplay();
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
    card.className = 'focus-timer-plugin-stat-card';
    
    const titleEl = document.createElement('div');
    titleEl.className = 'focus-timer-plugin-stat-card-title';
    titleEl.textContent = title;
    card.appendChild(titleEl);
    
    const mainValueRow = document.createElement('div');
    mainValueRow.className = 'focus-timer-plugin-stat-main-row';
    const mainValueEl = document.createElement('div');
    mainValueEl.className = 'focus-timer-plugin-stat-main-value';
    
    // 如果mainValue是对象（包含数字和单位），分开显示
    if (typeof mainValue === 'object' && mainValue.number) {
      const numberSpan = document.createElement('span');
      numberSpan.className = 'focus-timer-plugin-stat-number';
      numberSpan.textContent = mainValue.number;
      mainValueEl.appendChild(numberSpan);
      if (mainValue.unit) {
        const unitSpan = document.createElement('span');
        unitSpan.className = 'focus-timer-plugin-stat-unit';
        unitSpan.textContent = mainValue.unit;
        mainValueEl.appendChild(unitSpan);
      }
      if (mainValue.number2) {
        const number2Span = document.createElement('span');
        number2Span.className = 'focus-timer-plugin-stat-number';
        number2Span.textContent = mainValue.number2;
        mainValueEl.appendChild(number2Span);
      }
      if (mainValue.unit2) {
        const unit2Span = document.createElement('span');
        unit2Span.className = 'focus-timer-plugin-stat-unit';
        unit2Span.textContent = mainValue.unit2;
        mainValueEl.appendChild(unit2Span);
      }
    } else {
      // 处理"X 个任务"这种格式
      const parts = String(mainValue).split(/(\d+)/);
      parts.forEach(part => {
        if (part && !isNaN(part)) {
          const numberSpan = document.createElement('span');
          numberSpan.className = 'focus-timer-plugin-stat-number';
          numberSpan.textContent = part;
          mainValueEl.appendChild(numberSpan);
        } else if (part) {
          const unitSpan = document.createElement('span');
          unitSpan.className = 'focus-timer-plugin-stat-unit';
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
        comparisonEl.className = `focus-timer-plugin-stat-comparison ${isPositive ? 'focus-timer-plugin-comparison-positive' : 'focus-timer-plugin-comparison-negative'}`;
        
        const labelEl = document.createElement('div');
        labelEl.className = 'focus-timer-plugin-comparison-label';
        labelEl.textContent = label;
        comparisonEl.appendChild(labelEl);
        
        const valueEl = document.createElement('div');
        valueEl.className = 'focus-timer-plugin-comparison-value';
        valueEl.textContent = `${sign}${value}`;
        comparisonEl.appendChild(valueEl);
        
        mainValueRow.appendChild(comparisonEl);
      } else {
        const comparisonEl = document.createElement('div');
        comparisonEl.className = 'focus-timer-plugin-stat-comparison';
        comparisonEl.textContent = comparison;
        mainValueRow.appendChild(comparisonEl);
      }
    }
    
    card.appendChild(mainValueRow);
    
    // 平均值（单独一行）
    if (average) {
      // 检查是否是"全年累计完成"，如果是则添加额外的类
      const isYearlyTotal = average.includes(t("yearlyTotalCompleted")) || average.includes("全年累计完成");
      const averageClasses = isYearlyTotal ? "focus-timer-plugin-stat-average focus-timer-plugin-stat-average-yearly" : "focus-timer-plugin-stat-average";
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
      el.className = 'focus-timer-plugin-code-block';

      // 把当前 chart 配置挂在元素上，供刷新按钮复用
      el._chartRange = chartRange;
      el._chartMetric = chartMetric;
      
      // 如果指定了高度，应用到容器
      if (height !== null && height > 0) {
        el.style.setProperty('--focus-block-height', height + 'px');
        el.classList.add('focus-timer-plugin-code-block-with-height');
        // 存储高度值，供后续刷新使用
        el._focusBlockHeight = height;
      } else {
        el.style.removeProperty('--focus-block-height');
        el.classList.remove('focus-timer-plugin-code-block-with-height');
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
        statsSection.className = 'focus-timer-plugin-code-stats-section';
        
        // 如果设置了高度，statsSection不应该收缩
        if (height !== null && height > 0) {
          statsSection.classList.add('focus-timer-plugin-code-stats-section-no-shrink');
        }
        
        const statsHeader = document.createElement('div');
        statsHeader.className = 'focus-timer-plugin-code-stats-header';
        
        const title = document.createElement('h3');
        title.className = 'focus-timer-plugin-code-stats-title';
        title.textContent = t("focusHistory");
        statsHeader.appendChild(title);
        
        // 刷新按钮
        const refreshBtn = document.createElement('button');
        refreshBtn.className = 'focus-timer-plugin-code-refresh-btn';
        refreshBtn.setAttribute('aria-label', '刷新数据');
        refreshBtn.textContent = '↻';
        refreshBtn.title = '刷新数据';
        refreshBtn.addEventListener('click', async (e) => {
          e.preventDefault();
          refreshBtn.disabled = true;
          refreshBtn.classList.add('focus-timer-plugin-code-refresh-spin');
          try {
            await this.renderFocusBlock(el, ctx, targetDate, isToday, showRecord, showItems, height, el._chartRange, el._chartMetric);
          } finally {
            refreshBtn.disabled = false;
            refreshBtn.classList.remove('focus-timer-plugin-code-refresh-spin');
          }
        });
        statsHeader.appendChild(refreshBtn);
        
        statsSection.appendChild(statsHeader);
        
        // 2×2网格统计卡片
        const statsGrid = document.createElement('div');
        statsGrid.className = 'focus-timer-plugin-code-stats-grid';
        
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
      
      // 如果指定了日期且showItems为true，显示该日期的所有专注数据
      if (targetDate && showItems) {
        const historySection = document.createElement('div');
        historySection.className = 'focus-timer-plugin-code-history-section';
        
        // 如果设置了高度，让historySection使用flex布局以便historyContent可以滚动
        if (height !== null && height > 0) {
          historySection.classList.add('focus-timer-plugin-code-history-section-with-height');
        }
        
        const historyHeader = document.createElement('div');
        historyHeader.className = 'focus-timer-plugin-code-history-header';
        
        const historyTitle = document.createElement('h3');
        historyTitle.className = 'focus-timer-plugin-code-history-title';
        historyTitle.textContent = t("dayFocus");
        historyHeader.appendChild(historyTitle);
        
        // 仅当不显示专注数据时，在此处显示刷新按钮（否则已在专注记录标题旁显示）
        if (!showRecord) {
          const refreshBtnHistory = document.createElement('button');
          refreshBtnHistory.className = 'focus-timer-plugin-code-refresh-btn';
          refreshBtnHistory.setAttribute('aria-label', '刷新数据');
          refreshBtnHistory.textContent = '↻';
          refreshBtnHistory.title = '刷新数据';
          refreshBtnHistory.addEventListener('click', async (e) => {
            e.preventDefault();
            refreshBtnHistory.disabled = true;
            refreshBtnHistory.classList.add('focus-timer-plugin-code-refresh-spin');
            try {
              await this.renderFocusBlock(el, ctx, targetDate, isToday, showRecord, showItems, height, el._chartRange, el._chartMetric);
            } finally {
              refreshBtnHistory.disabled = false;
              refreshBtnHistory.classList.remove('focus-timer-plugin-code-refresh-spin');
            }
          });
          historyHeader.appendChild(refreshBtnHistory);
        }
        
        historySection.appendChild(historyHeader);
        
        const historyContent = document.createElement('div');
        historyContent.className = 'focus-timer-plugin-code-history-content';
        
        // 如果设置了高度，让historyContent可滚动
        if (height !== null && height > 0) {
          historyContent.classList.add('focus-timer-plugin-code-history-content-scrollable');
        }
        
        // 按时间排序（倒序，最新的在上面）
        const sortedSessions = [...dateSessions].sort((a, b) => {
          return new Date(b.start).getTime() - new Date(a.start).getTime();
        });
        
        if (sortedSessions.length === 0) {
          const emptyMsg = document.createElement('div');
          emptyMsg.className = 'focus-timer-plugin-code-history-empty';
          emptyMsg.textContent = t("noFocusRecordsToday");
          historyContent.appendChild(emptyMsg);
        } else {
          sortedSessions.forEach(session => {
            const item = document.createElement('div');
            item.className = 'focus-timer-plugin-code-history-item';
            
            const time = new Date(session.end || session.start);
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
            entry.className = `focus-timer-plugin-code-history-entry ${session.status === "completed" ? "focus-timer-plugin-status-completed" : "focus-timer-plugin-status-abandoned"}`;
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
        chartContainer.className = 'focus-timer-plugin-code-chart';
        
        // 计算图表范围标签和用于计算数据的范围值（统一走 chartRangeToLabelAndCalculation）
        const shortKey = CHART_RANGE_CONFIG.some(c => c.shortKey === chartRange) ? chartRange : defaultChartRangeToShortKey(this.settings.defaultChartRange);
        const { rangeLabel, rangeForCalculation } = chartRangeToLabelAndCalculation(shortKey);

        const chartHeader = document.createElement('div');
        chartHeader.className = 'focus-timer-plugin-code-chart-header';
        
        const chartTitle = document.createElement('h3');
        chartTitle.className = 'focus-timer-plugin-code-chart-title';
        const lang = getLanguage();
        chartTitle.textContent = lang === 'zh' ? `${t("focusTrend")}（${rangeLabel}）` : `${t("focusTrend")} (${rangeLabel})`;
        chartHeader.appendChild(chartTitle);
        
        const refreshBtnChart = document.createElement('button');
        refreshBtnChart.className = 'focus-timer-plugin-code-refresh-btn';
        refreshBtnChart.setAttribute('aria-label', '刷新数据');
        refreshBtnChart.textContent = '↻';
        refreshBtnChart.title = '刷新数据';
        refreshBtnChart.addEventListener('click', async (e) => {
          e.preventDefault();
          refreshBtnChart.disabled = true;
          refreshBtnChart.classList.add('focus-timer-plugin-code-refresh-spin');
          try {
            await this.renderFocusBlock(el, ctx, targetDate, isToday, showRecord, showItems, height, el._chartRange, el._chartMetric);
          } finally {
            refreshBtnChart.disabled = false;
            refreshBtnChart.classList.remove('focus-timer-plugin-code-refresh-spin');
          }
        });
        chartHeader.appendChild(refreshBtnChart);
        
        chartContainer.appendChild(chartHeader);
        
        const chartCanvasContainer = document.createElement('div');
        chartCanvasContainer.className = 'focus-timer-plugin-code-chart-canvas';
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
          emptyMsg.className = 'focus-timer-plugin-code-history-empty';
          emptyMsg.textContent = t("noData");
          chartCanvasContainer.appendChild(emptyMsg);
        }
      }
    } catch (error) {
      const errorDiv = document.createElement('div');
      errorDiv.className = 'focus-timer-plugin-code-error';
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
