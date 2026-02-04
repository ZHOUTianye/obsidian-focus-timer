const obsidian = require("obsidian");
const { ItemView, Notice } = obsidian;
const { VIEW_TYPE, MAX_SUGGEST_TASKS } = require("./constants.js");
const { t, getLanguage } = require("./i18n.js");
const { readState, readSessions } = require("./data.js");
const { formatTime, formatTimeChinese, formatTimeShort, getDateKey } = require("./format.js");
const { calculateStats } = require("./stats.js");
const { createLineChart, calculateChartData, chartRangeToLabelAndCalculation, defaultChartRangeToShortKey, CHART_RANGE_CONFIG } = require("./chart.js");
const { limitInputLength, truncateForButton } = require("./utils.js");

class FocusTimerView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.timerElements = null; // 保存计时器相关DOM元素的引用
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
    this.plugin.updateTickingState();
    this.updateTimerDisplay();
  }

  stopTimer() {
    // 统一计时器由插件管理，这里无需单独清理
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
          // 开关关闭时：倒计时结束时保持 0，自动完成由统一计时器处理
          timeEl.textContent = formatTime(0);
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
      // 图表按钮放在"专注记录"按钮的右侧
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
    //   statsHeader.createEl("h3", { text: "专注数据", cls: "focus-stats-title" });
      
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

      // 专注记录
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

module.exports = { FocusTimerView };
