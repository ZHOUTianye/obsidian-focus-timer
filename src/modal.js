const obsidian = require("obsidian");
const { Modal } = obsidian;
const { t } = require("./i18n.js");

class ConfirmModal extends Modal {
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

    contentEl.createEl("p", { text: this.messageText, cls: "focus-timer-plugin-confirm-message" });

    const buttons = contentEl.createDiv({ cls: "focus-timer-plugin-confirm-buttons" });

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

module.exports = { ConfirmModal };
