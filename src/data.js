const path = require("path");
const fs = require("fs");
const { DATA_PATH, dataFileLock, getDefaultDataTemplate } = require("./core.js");

/** 确保 data.json 所在目录存在（adapter.write 不会自动创建父目录） */
async function ensureDataDirExists(app) {
  const basePath = app.vault.adapter.basePath;
  if (basePath) {
    const dir = path.join(basePath, path.dirname(DATA_PATH));
    await fs.promises.mkdir(dir, { recursive: true });
  }
}

async function ensureDataFileExists(app) {
  await ensureDataDirExists(app);
  await dataFileLock.runWithLock(async () => {
    const exists = await app.vault.adapter.exists(DATA_PATH);
    if (!exists) {
      await writeJson(app, DATA_PATH, getDefaultDataTemplate());
    }
  });
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

async function readDataFile(app) {
  return await readJson(app, DATA_PATH, getDefaultDataTemplate());
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
    const data = await readDataFile(app);
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
    const data = await readDataFile(app);
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
    const data = await readDataFile(app);
    data.settings = { ...data.settings, ...settings };
    await writeJson(app, DATA_PATH, data);
  });
}

async function appendSession(app, session) {
  await ensureDataFileExists(app);
  await dataFileLock.runWithLock(async () => {
    const data = await readDataFile(app);
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
  ensureDataFileExists,
  readDataFile,
  writeDataFile,
  readState,
  writeState,
  readSessions,
  writeSessions,
  readSettings,
  writeSettings,
  appendSession
};
