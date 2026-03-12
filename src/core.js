const DATA_PATH = ".obsidian/plugins/obsidian-focus-timer/data.json";

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

module.exports = { DATA_PATH, FileLock, dataFileLock, TimerManager, getDefaultDataTemplate };
