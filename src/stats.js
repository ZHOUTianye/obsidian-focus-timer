const { getDateKey } = require("./format.js");

function calculateStats(sessions, baseDate = null) {
  let now, today;
  if (baseDate) {
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

  const yearStart = new Date(now.getFullYear(), 0, 1);

  const byDate = {};
  sessions.forEach(s => {
    if (s.status !== "completed") return;
    const dateKey = getDateKey(s.start);
    if (!byDate[dateKey]) {
      byDate[dateKey] = 0;
    }
    byDate[dateKey] += s.actualSec || 0;
  });

  const todayKey = getDateKey(now);
  const todayTotal = byDate[todayKey] || 0;
  const todayCompleted = sessions.filter(s => {
    const sessionDate = getDateKey(new Date(s.start));
    return sessionDate === todayKey && s.status === "completed";
  }).length;

  const yesterdayKey = getDateKey(yesterday);
  const yesterdayTotal = byDate[yesterdayKey] || 0;
  const yesterdayDiff = todayTotal - yesterdayTotal;
  const yesterdayCompleted = sessions.filter(s => {
    const sessionDate = getDateKey(new Date(s.start));
    return sessionDate === yesterdayKey && s.status === "completed";
  }).length;
  const yesterdayCompletedDiff = todayCompleted - yesterdayCompleted;

  const last7Days = [];
  for (let i = 0; i < 7; i++) {
    const date = new Date(today);
    date.setDate(date.getDate() - i);
    const key = getDateKey(date);
    last7Days.push(byDate[key] || 0);
  }
  const avg7Days = last7Days.reduce((a, b) => a + b, 0) / 7;
  const avg7DaysDiff = todayTotal - avg7Days;
  const movingAvg = avg7Days;
  const movingAvgDiff = todayTotal - movingAvg;

  const currentMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  currentMonthStart.setHours(0, 0, 0, 0);
  const currentMonthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0);
  currentMonthEnd.setHours(23, 59, 59, 999);
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

  const lastMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  lastMonthStart.setHours(0, 0, 0, 0);
  const lastMonthEnd = new Date(now.getFullYear(), now.getMonth(), 0);
  lastMonthEnd.setHours(23, 59, 59, 999);
  const lastMonthDays = lastMonthEnd.getDate();
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

  const monthDiff = avgCurrentMonth - avgLastMonth;
  const monthCompletedDiff = avgCurrentMonthCompleted - avgLastMonthCompleted;

  const last30Days = [];
  for (let i = 0; i < 30; i++) {
    const date = new Date(today);
    date.setDate(date.getDate() - i);
    const key = getDateKey(date);
    last30Days.push(byDate[key] || 0);
  }
  const avg30Days = last30Days.reduce((a, b) => a + b, 0) / 30;

  const yearSessions = sessions.filter(s => new Date(s.start) >= yearStart);
  const yearTotal = yearSessions
    .filter(s => s.status === "completed")
    .reduce((sum, s) => sum + (s.actualSec || 0), 0);
  const daysInYear = Math.floor((now - yearStart) / (1000 * 60 * 60 * 24)) + 1;
  const avgYear = yearTotal / daysInYear;

  const last14Days = [];
  for (let i = 13; i >= 0; i--) {
    const date = new Date(today);
    date.setDate(date.getDate() - i);
    const key = getDateKey(date);
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
    avgCurrentMonth,
    avgCurrentMonthCompleted,
    avgLastMonth,
    avgLastMonthCompleted,
    monthDiff,
    monthCompletedDiff,
    avgYear,
    yearTotal,
    yearCompleted,
    avgYearCompleted,
    last14Days
  };
}

module.exports = { calculateStats };
