const obsidian = require("obsidian");
const { PluginSettingTab, Setting, Notice } = obsidian;
const { MAX_SUGGEST_TASKS } = require("./constants.js");
const { t, getLanguage } = require("./i18n.js");
const { readSettings, writeSettings, writeSessions, readSessions } = require("./data.js");
const { ConfirmModal } = require("./modal.js");
const { limitInputLength } = require("./utils.js");

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
                this.plugin.statusBarEl.addClass("focus-timer-plugin-timer-statusbar");
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
        text.inputEl.classList.add("focus-timer-plugin-settings-textarea");
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

module.exports = { FocusTimerSettingTab };
