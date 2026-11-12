import { App, Modal, Setting } from 'obsidian';

export function promptText(app: App, title: string, initial = '', okLabel = 'OK', cancelLabel = 'Cancel'): Promise<string | null> {
  return new Promise(resolve => {
    class PromptModal extends Modal {
      private value = initial;
      override onOpen(): void {
        this.titleEl.setText(title);
        new Setting(this.contentEl).addText(text => {
          text.setValue(initial).onChange(value => { this.value = value; });
          window.setTimeout(() => text.inputEl.focus(), 0);
        });
        new Setting(this.contentEl)
          .addButton(button => button.setButtonText(cancelLabel).onClick(() => { resolve(null); this.close(); }))
          .addButton(button => button.setButtonText(okLabel).setCta().onClick(() => { resolve(this.value.trim() ? this.value.trim() : null); this.close(); }));
      }
      override onClose(): void {
        resolve(null);
      }
    }
    new PromptModal(app).open();
  });
}

export function confirmAction(app: App, message: string, okLabel = 'OK', cancelLabel = 'Cancel'): Promise<boolean> {
  return new Promise(resolve => {
    class ConfirmModal extends Modal {
      override onOpen(): void {
        this.contentEl.createEl('p', { text: message });
        new Setting(this.contentEl)
          .addButton(button => button.setButtonText(cancelLabel).onClick(() => { resolve(false); this.close(); }))
          .addButton(button => button.setButtonText(okLabel).setCta().onClick(() => { resolve(true); this.close(); }));
      }
      override onClose(): void {
        resolve(false);
      }
    }
    new ConfirmModal(app).open();
  });
}
