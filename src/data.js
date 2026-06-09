const { DATA_DIR, DATA_PATH, LEGACY_DATA_PATH, dataFileLock, getDefaultDataTemplate } = require("./core.js");

class DataFileCorruptError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = "DataFileCorruptError";
    this.cause = cause;
  }
}

/** 确保 data.json 所在目录存在（adapter.write 不会自动创建父目录） */
async function ensureDataDirExists(app) {
  const adapter = app.vault.adapter;
  if (await adapter.exists(DATA_DIR)) return;
  try {
    await adapter.mkdir(DATA_DIR);
  } catch {
    // 插件目录通常已由 Obsidian 安装时创建
  }
}

async function ensureDataFileExists(app) {
  await ensureDataDirExists(app);
  await dataFileLock.runWithLock(async () => {
    const adapter = app.vault.adapter;
    if (await adapter.exists(DATA_PATH)) return;

    if (await adapter.exists(LEGACY_DATA_PATH)) {
      const legacyRaw = await adapter.read(LEGACY_DATA_PATH);
      await adapter.write(DATA_PATH, legacyRaw);
      return;
    }

    await writeJson(app, DATA_PATH, getDefaultDataTemplate());
  });
}

async function ensureJsonFile(app, path, fallbackObj) {
  const exists = await app.vault.adapter.exists(path);
  if (!exists) {
    await app.vault.adapter.write(path, JSON.stringify(fallbackObj, null, 2));
  }
}

async function writeJson(app, path, obj) {
  await app.vault.adapter.write(path, JSON.stringify(obj, null, 2));
}

function stripBom(raw) {
  return raw.trim().replace(/^\uFEFF/, "");
}

function isValidSession(session) {
  if (!session || typeof session !== "object") return false;
  if (session.id == null) return false;
  if (typeof session.start !== "string" || !session.start) return false;
  if (typeof session.status !== "string") return false;
  return session.status === "completed" || session.status === "abandoned";
}

function normalizeDataFile(data) {
  const template = getDefaultDataTemplate();
  const normalized = {
    state:
      data && data.state && typeof data.state === "object"
        ? { ...template.state, ...data.state }
        : { ...template.state },
    sessions: [],
    settings:
      data && data.settings && typeof data.settings === "object"
        ? { ...template.settings, ...data.settings }
        : { ...template.settings }
  };

  if (data && Array.isArray(data.sessions)) {
    normalized.sessions = data.sessions.filter(isValidSession);
  }

  return normalized;
}

function tryParseJson(raw) {
  try {
    return { ok: true, data: JSON.parse(raw) };
  } catch (error) {
    return { ok: false, error };
  }
}

/** 截断尾部损坏内容，尝试恢复完整 JSON */
function salvageJsonByTruncation(raw) {
  for (let i = raw.length; i > 10; i--) {
    const ch = raw[i - 1];
    if (ch !== "}" && ch !== "]") continue;
    try {
      return { data: JSON.parse(raw.slice(0, i)), truncated: true };
    } catch {
      // keep trying shorter prefixes
    }
  }
  return null;
}

/** 从损坏文本中提取单个顶层 JSON 对象（如 state / settings） */
function extractJsonObject(raw, key) {
  const idx = raw.indexOf(`"${key}"`);
  if (idx === -1) return null;

  const braceStart = raw.indexOf("{", idx);
  if (braceStart === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = braceStart; i < raw.length; i++) {
    const c = raw[i];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (c === "\\") {
        escaped = true;
      } else if (c === '"') {
        inString = false;
      }
      continue;
    }

    if (c === '"') {
      inString = true;
      continue;
    }

    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(raw.slice(braceStart, i + 1));
        } catch {
          return null;
        }
      }
    }
  }

  return null;
}

/** 逐条解析 sessions 数组中的对象，跳过损坏条目 */
function extractSessionsFromRaw(raw) {
  const sessions = [];
  const idx = raw.indexOf('"sessions"');
  if (idx === -1) return sessions;

  const arrayStart = raw.indexOf("[", idx);
  if (arrayStart === -1) return sessions;

  let depth = 0;
  let inString = false;
  let escaped = false;
  let objStart = -1;

  for (let i = arrayStart + 1; i < raw.length; i++) {
    const c = raw[i];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (c === "\\") {
        escaped = true;
      } else if (c === '"') {
        inString = false;
      }
      continue;
    }

    if (c === '"') {
      inString = true;
      continue;
    }

    if (c === "{") {
      if (depth === 0) objStart = i;
      depth++;
    } else if (c === "}") {
      depth--;
      if (depth === 0 && objStart >= 0) {
        try {
          const obj = JSON.parse(raw.slice(objStart, i + 1));
          if (isValidSession(obj)) sessions.push(obj);
        } catch {
          // skip corrupt session entry
        }
        objStart = -1;
      }
    } else if (c === "]" && depth === 0) {
      break;
    }
  }

  return sessions;
}

/**
 * 尝试从原始文本抢救 data.json。
 * 策略：直接解析 → 截断尾部 → 分段提取 state/settings/sessions。
 */
function salvageDataFile(raw) {
  const trimmed = stripBom(raw);

  const direct = tryParseJson(trimmed);
  if (direct.ok) {
    const normalized = normalizeDataFile(direct.data);
    const originalCount = Array.isArray(direct.data.sessions) ? direct.data.sessions.length : 0;
    return {
      data: normalized,
      salvaged: originalCount !== normalized.sessions.length,
      partial: false
    };
  }

  const truncated = salvageJsonByTruncation(trimmed);
  if (truncated) {
    return {
      data: normalizeDataFile(truncated.data),
      salvaged: true,
      partial: true
    };
  }

  const state = extractJsonObject(trimmed, "state");
  const settings = extractJsonObject(trimmed, "settings");
  const sessions = extractSessionsFromRaw(trimmed);

  if (state || settings || sessions.length > 0) {
    const template = getDefaultDataTemplate();
    return {
      data: normalizeDataFile({
        state: state || template.state,
        settings: settings || template.settings,
        sessions
      }),
      salvaged: true,
      partial: true
    };
  }

  return null;
}

async function loadDataFile(app, { allowDefault = true, repair = false } = {}) {
  const exists = await app.vault.adapter.exists(DATA_PATH);
  if (!exists) {
    return {
      data: getDefaultDataTemplate(),
      fileExists: false,
      salvaged: false,
      unrecoverable: false
    };
  }

  let raw;
  try {
    raw = await app.vault.adapter.read(DATA_PATH);
  } catch (error) {
    throw new DataFileCorruptError("无法读取 data.json", error);
  }

  const trimmed = stripBom(raw);
  const direct = tryParseJson(trimmed);

  if (direct.ok) {
    const normalized = normalizeDataFile(direct.data);
    const originalCount = Array.isArray(direct.data.sessions) ? direct.data.sessions.length : 0;
    const salvaged = originalCount !== normalized.sessions.length;

    if (repair && salvaged) {
      await writeJson(app, DATA_PATH, normalized);
    }

    return {
      data: normalized,
      fileExists: true,
      salvaged,
      unrecoverable: false
    };
  }

  const salvageResult = salvageDataFile(raw);
  if (salvageResult) {
    if (repair) {
      await writeJson(app, DATA_PATH, salvageResult.data);
    }
    return {
      data: salvageResult.data,
      fileExists: true,
      salvaged: true,
      unrecoverable: false,
      partial: salvageResult.partial
    };
  }

  if (allowDefault) {
    return {
      data: getDefaultDataTemplate(),
      fileExists: true,
      salvaged: false,
      unrecoverable: true
    };
  }

  throw new DataFileCorruptError("data.json 已损坏且无法自动修复，请手动备份后处理");
}

async function readDataFile(app) {
  const result = await loadDataFile(app, { allowDefault: true, repair: true });
  return result.data;
}

async function readDataFileForWrite(app) {
  const exists = await app.vault.adapter.exists(DATA_PATH);
  if (!exists) {
    return getDefaultDataTemplate();
  }

  const result = await loadDataFile(app, { allowDefault: false, repair: true });
  return result.data;
}

async function writeDataFile(app, data) {
  await dataFileLock.runWithLock(async () => {
    await writeJson(app, DATA_PATH, data);
  });
}

async function readState(app) {
  const data = await readDataFile(app);
  return data.state || { active: false, resting: false };
}

async function writeState(app, state) {
  await dataFileLock.runWithLock(async () => {
    const data = await readDataFileForWrite(app);
    data.state = { ...data.state, ...state };
    await writeJson(app, DATA_PATH, data);
  });
}

async function readSessions(app) {
  const data = await readDataFile(app);
  return Array.isArray(data.sessions) ? data.sessions : [];
}

async function writeSessions(app, sessions) {
  await dataFileLock.runWithLock(async () => {
    const data = await readDataFileForWrite(app);
    data.sessions = sessions;
    await writeJson(app, DATA_PATH, data);
  });
}

async function readSettings(app) {
  const data = await readDataFile(app);
  return data.settings || {};
}

async function writeSettings(app, settings) {
  await dataFileLock.runWithLock(async () => {
    const data = await readDataFileForWrite(app);
    data.settings = { ...data.settings, ...settings };
    await writeJson(app, DATA_PATH, data);
  });
}

async function appendSession(app, session) {
  await ensureDataFileExists(app);
  await dataFileLock.runWithLock(async () => {
    const data = await readDataFileForWrite(app);
    const sessions = Array.isArray(data.sessions) ? data.sessions : [];
    if (session && session.id != null) {
      const exists = sessions.some((item) => item && item.id === session.id);
      if (exists) return;
    }
    sessions.push(session);
    data.sessions = sessions;
    await writeJson(app, DATA_PATH, data);
  });
}

module.exports = {
  DataFileCorruptError,
  ensureDataFileExists,
  readDataFile,
  writeDataFile,
  readState,
  writeState,
  readSessions,
  writeSessions,
  readSettings,
  writeSettings,
  appendSession,
  // exported for testing
  isValidSession,
  normalizeDataFile,
  salvageDataFile
};
