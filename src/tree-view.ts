import * as vscode from 'vscode';
import * as path from 'path';
import { StateManager } from './state-manager';
import { PendingChange } from './types';

export class PendingChangesProvider implements vscode.TreeDataProvider<PendingChangeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<PendingChangeItem | undefined | null | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private stateManager: StateManager) {
    // Refresh tree whenever state changes
    stateManager.onDidChange(() => this.refresh());
  }

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: PendingChangeItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: PendingChangeItem): Thenable<PendingChangeItem[]> {
    if (element) return Promise.resolve([]);

    const pending = this.stateManager.getAllPending();
    if (pending.length === 0) {
      // Show a placeholder item when empty
      const emptyItem = new PendingChangeItem(
        {
          id: '__empty__',
          filePath: '',
          backupPath: '',
          timestamp: '',
          fileHashAfterEdit: '',
          editType: 'suggest_edit',
          description: 'No pending AI changes',
        },
        true
      );
      return Promise.resolve([emptyItem]);
    }

    return Promise.resolve(pending.map(c => new PendingChangeItem(c)));
  }

  dispose(): void {
    this._onDidChangeTreeData.dispose();
  }
}

export class PendingChangeItem extends vscode.TreeItem {
  readonly changeId: string;
  readonly filePath: string;

  constructor(change: PendingChange, isEmpty = false) {
    const label = isEmpty ? 'No pending AI changes' : path.basename(change.filePath);
    super(label, vscode.TreeItemCollapsibleState.None);

    this.changeId = change.id;
    this.filePath = change.filePath;

    if (isEmpty) {
      this.contextValue = 'empty';
      this.iconPath = new vscode.ThemeIcon('info');
      return;
    }

    // Relative path as description
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
    const relativePath = change.filePath.startsWith(workspaceRoot)
      ? change.filePath.slice(workspaceRoot.length + 1)
      : change.filePath;

    this.description = change.description
      ? `${relativePath} — ${change.description}`
      : relativePath;

    // Tooltip shows full details
    const date = new Date(change.timestamp).toLocaleString();
    this.tooltip = new vscode.MarkdownString(
      [
        `**$(file) ${path.basename(change.filePath)}**`,
        ``,
        `📁 \`${change.filePath}\``,
        `🕒 ${date}`,
        change.description ? `📝 ${change.description}` : '',
        change.conversationId ? `🔑 Conversation: \`${change.conversationId.slice(0, 16)}...\`` : '',
      ]
        .filter(Boolean)
        .join('\n\n')
    );
    this.tooltip.isTrusted = true;

    this.contextValue = 'pendingChange';
    this.iconPath = new vscode.ThemeIcon('diff', new vscode.ThemeColor('gitDecoration.modifiedResourceForeground'));

    // Click to open diff
    this.command = {
      command: 'vscode-diff-mcp.openDiff',
      title: 'View Diff',
      arguments: [this.changeId],
    };
  }
}
