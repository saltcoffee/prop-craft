import { ItemView, WorkspaceLeaf } from 'obsidian';
import { h, render } from 'preact';
import { VIEW_TYPE_PROP_CRAFT } from '../constants';
import type PropCraftPlugin from '../main';
import { App } from './App';

export class PropCraftView extends ItemView {
  constructor(leaf: WorkspaceLeaf, private readonly plugin: PropCraftPlugin) {
    super(leaf);
  }

  override getViewType(): string {
    return VIEW_TYPE_PROP_CRAFT;
  }

  override getDisplayText(): string {
    return 'PropCraft';
  }

  override getIcon(): string {
    return 'table';
  }

  override async onOpen(): Promise<void> {
    this.contentEl.empty();
    this.contentEl.addClass('propcraft-view');
    render(h(App, { plugin: this.plugin }), this.contentEl);
  }

  override async onClose(): Promise<void> {
    render(null, this.contentEl);
  }
}
