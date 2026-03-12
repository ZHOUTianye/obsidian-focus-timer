const { getLanguage } = require("./i18n.js");

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
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

module.exports = {
  msBetween,
  formatTime,
  formatDate,
  formatHours,
  formatTimeChinese,
  formatTimeShort,
  getDateKey
};
