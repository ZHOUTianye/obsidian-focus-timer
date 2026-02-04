const { t, getLanguage } = require("./i18n.js");
const { getDateKey } = require("./format.js");

const CHART_RANGE_CONFIG = [
  { shortKey: "7", settingValues: ["7天", "7 Days"], labelKey: "days7", calcValue: "7天" },
  { shortKey: "14", settingValues: ["14天", "14 Days"], labelKey: "days14", calcValue: "14天" },
  { shortKey: "30", settingValues: ["30天", "30 Days"], labelKey: "days30", calcValue: "30天" },
  { shortKey: "month", settingValues: ["本月", "This Month"], labelKey: "thisMonth", calcValue: "本月" },
  { shortKey: "year", settingValues: ["今年", "This Year"], labelKey: "thisYear", calcValue: "今年" }
];
const DEFAULT_CHART_RANGE_SHORT = "14";

function defaultChartRangeToShortKey(defaultRange) {
  if (!defaultRange) return DEFAULT_CHART_RANGE_SHORT;
  const found = CHART_RANGE_CONFIG.find(c => c.settingValues.includes(defaultRange));
  return found ? found.shortKey : DEFAULT_CHART_RANGE_SHORT;
}

function chartRangeToLabelAndCalculation(shortKey) {
  const found = CHART_RANGE_CONFIG.find(c => c.shortKey === shortKey);
  if (found) return { rangeLabel: t(found.labelKey), rangeForCalculation: found.calcValue };
  const fallback = CHART_RANGE_CONFIG.find(c => c.shortKey === DEFAULT_CHART_RANGE_SHORT);
  return { rangeLabel: t(fallback.labelKey), rangeForCalculation: fallback.calcValue };
}

function calculateChartData(sessions, range) {
  const now = new Date();
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);

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

    let currentWeekStart = new Date(yearStart);
    const dayOfWeek = currentWeekStart.getDay();
    const daysToMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
    currentWeekStart.setDate(currentWeekStart.getDate() - daysToMonday);

    while (currentWeekStart <= yearEnd) {
      let weekEnd = new Date(currentWeekStart);
      weekEnd.setDate(weekEnd.getDate() + 6);

      let weekValue = 0;
      let weekCompleted = 0;
      let d = new Date(currentWeekStart);
      const weekEndCopy = new Date(weekEnd);
      while (d <= weekEndCopy && d <= yearEnd) {
        const key = getDateKey(d);
        weekValue += byDate[key]?.value || 0;
        weekCompleted += byDate[key]?.completed || 0;
        d = new Date(d);
        d.setDate(d.getDate() + 1);
      }

      data.push({
        date: getDateKey(currentWeekStart),
        value: weekValue,
        completed: weekCompleted
      });

      currentWeekStart.setDate(currentWeekStart.getDate() + 7);
    }
  }

  return data;
}

function createLineChart(container, data, opts = { showTime: true, showCount: true, interactive: true }) {
  if (!container || !(container instanceof Element || container instanceof HTMLElement)) return;
  if (!data || !Array.isArray(data) || data.length === 0) return;

  const existingCanvas = container.querySelector("canvas");
  if (existingCanvas) existingCanvas.remove();
  const existingTooltip = container.querySelector(".focus-timer-plugin-chart-tooltip");
  if (existingTooltip) existingTooltip.remove();

  const interactive = opts.interactive !== false;
  const canvas = document.createElement("canvas");
  canvas.className = "focus-timer-plugin-line-chart";
  const dpr = window.devicePixelRatio || 1;
  const width = 600;
  const height = 200;
  canvas.width = width * dpr;
  canvas.height = height * dpr;
  canvas.style.setProperty("--focus-canvas-width", width + "px");
  canvas.style.setProperty("--focus-canvas-height", height + "px");
  canvas.classList.add(interactive ? "focus-timer-plugin-line-chart-interactive" : "focus-timer-plugin-line-chart-static");
  container.appendChild(canvas);

  let tooltip = null;
  if (interactive) {
    tooltip = document.createElement("div");
    tooltip.className = "focus-timer-plugin-chart-tooltip focus-timer-plugin-chart-tooltip-hidden";
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
        testEl.className = "focus-timer-plugin-test-element";
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
    const xLabelStep = 2;
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
        tooltip.classList.remove("focus-timer-plugin-chart-tooltip-right");
        const date = new Date(nearestPoint.point.date);
        const lang = getLanguage();
        const dateStr = lang === "zh" ? `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日` : `${date.getMonth() + 1}/${date.getDate()}/${date.getFullYear()}`;
        const hours = Math.floor(nearestPoint.point.value / 3600);
        const minutes = Math.floor((nearestPoint.point.value % 3600) / 60);
        const timeStr = lang === "zh" ? (hours > 0 ? `${hours}时${minutes}分` : `${minutes}分`) : (hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`);
        const completedCount = nearestPoint.point.completed || 0;
        while (tooltip.firstChild) tooltip.removeChild(tooltip.firstChild);
        const titleDiv = document.createElement("div");
        titleDiv.className = "focus-timer-plugin-chart-tooltip-title";
        titleDiv.textContent = dateStr;
        tooltip.appendChild(titleDiv);
        if (showTime) {
          const timeDiv = document.createElement("div");
          timeDiv.className = "focus-timer-plugin-chart-tooltip-line";
          timeDiv.textContent = `${t("focusTime")}: ${timeStr}`;
          tooltip.appendChild(timeDiv);
        }
        if (showCount) {
          const countDiv = document.createElement("div");
          countDiv.className = "focus-timer-plugin-chart-tooltip-line";
          countDiv.textContent = `${t("completedTasks")}: ${completedCount}${lang === "zh" ? "个" : ""}`;
          tooltip.appendChild(countDiv);
        }
        tooltip.classList.remove("focus-timer-plugin-chart-tooltip-hidden");
        tooltip.classList.add("focus-timer-plugin-chart-tooltip-measuring");
        const tooltipRect = tooltip.getBoundingClientRect();
        tooltip.classList.remove("focus-timer-plugin-chart-tooltip-measuring");
        let tooltipX = nearestPoint.x;
        let tooltipY = nearestPoint.y - tooltipRect.height - 15;
        if (tooltipY < 0) tooltipY = nearestPoint.y + 20;
        const tooltipHalfWidth = tooltipRect.width / 2;
        tooltipX = Math.max(tooltipHalfWidth, Math.min(width - tooltipHalfWidth, tooltipX));
        if (tooltipX + tooltipHalfWidth > width - 5) tooltipX = Math.max(tooltipHalfWidth, width - tooltipHalfWidth - 5);
        if (tooltipX - tooltipHalfWidth < 5) tooltipX = Math.min(width - tooltipHalfWidth, tooltipHalfWidth + 5);
        tooltip.style.setProperty("--focus-tooltip-left", tooltipX + "px");
        tooltip.style.setProperty("--focus-tooltip-top", tooltipY + "px");
        tooltip.classList.add("focus-timer-plugin-chart-tooltip-centered");
      } else {
        tooltip.classList.add("focus-timer-plugin-chart-tooltip-hidden");
        tooltip.classList.remove("focus-timer-plugin-chart-tooltip-right", "focus-timer-plugin-chart-tooltip-centered");
      }
    });
    canvas.addEventListener("mouseleave", () => {
      tooltip.classList.add("focus-timer-plugin-chart-tooltip-hidden");
      tooltip.classList.remove("focus-timer-plugin-chart-tooltip-centered");
    });
  }
}

module.exports = {
  CHART_RANGE_CONFIG,
  DEFAULT_CHART_RANGE_SHORT,
  defaultChartRangeToShortKey,
  chartRangeToLabelAndCalculation,
  calculateChartData,
  createLineChart
};
