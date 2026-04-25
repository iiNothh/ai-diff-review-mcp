import * as vscode from 'vscode';
import { StateManager } from './state-manager';
import { PendingChangesProvider } from './tree-view';
import { registerCommands } from './commands';
import { startMcpServer } from './server';
import * as http from 'http';

let mcpHttpServer: http.Server | undefined;
let stateManager: StateManager | undefined;
let statusBarItem: vscode.StatusBarItem | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  console.log('[vscode-diff-mcp] Activating extension...');

  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders?.length) {
    vscode.window.showWarningMessage(
      'AI Diff Review: No workspace folder open. Extension will not activate.'
    );
    return;
  }

  const workspaceRoot = workspaceFolders[0].uri.fsPath;

  // ── State Manager ────────────────────────────────────────
  stateManager = new StateManager(workspaceRoot);
  await stateManager.loadState();

  // ── Sidebar TreeView ──────────────────────────────────────
  const treeProvider = new PendingChangesProvider(stateManager);
  const treeView = vscode.window.createTreeView('pendingAiChanges', {
    treeDataProvider: treeProvider,
    showCollapseAll: false,
  });

  // ── Status Bar Item ───────────────────────────────────────
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBarItem.command = 'pendingAiChanges.focus';
  context.subscriptions.push(statusBarItem);

  const updateUI = () => {
    const count = stateManager!.getAllPending().length;

    // Badge
    treeView.badge = count > 0
      ? { value: count, tooltip: `${count} pending AI change${count === 1 ? '' : 's'}` }
      : undefined;

    // Status bar
    const port = vscode.workspace.getConfiguration('aiDiffReview').get<number>('port', 6070);
    if (count > 0) {
      statusBarItem!.text = `$(diff) AI: ${count} pending`;
      statusBarItem!.tooltip = `${count} pending AI change${count === 1 ? '' : 's'} — click to review\nMCP server on :${port}`;
      statusBarItem!.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    } else {
      statusBarItem!.text = `$(circle-filled) MCP :${port}`;
      statusBarItem!.tooltip = `AI Diff Review MCP server running on port ${port}\nNo pending changes`;
      statusBarItem!.backgroundColor = undefined;
    }
    statusBarItem!.show();
  };

  stateManager.onDidChange(updateUI);
  updateUI();

  context.subscriptions.push(treeView);
  context.subscriptions.push(treeProvider);

  // ── Commands ──────────────────────────────────────────────
  registerCommands(context, stateManager);

  // ── MCP Server ────────────────────────────────────────────
  const port = vscode.workspace.getConfiguration('aiDiffReview').get<number>('port', 6070);
  try {
    const result = await startMcpServer(stateManager, port);
    mcpHttpServer = result.httpServer;
    console.log(`[vscode-diff-mcp] MCP server started — http://127.0.0.1:${port}/mcp`);
    vscode.window.showInformationMessage(`AI Diff Review (MCP) is active ✅  —  port ${port}`);
  } catch (err) {
    statusBarItem.text = `$(error) MCP failed`;
    statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
    statusBarItem.tooltip = `MCP server failed to start on port ${port}: ${err}`;
    console.error('[vscode-diff-mcp] Failed to start MCP server:', err);
    vscode.window.showErrorMessage(
      `AI Diff Review: MCP server failed to start on port ${port} — ${err instanceof Error ? err.message : err}`
    );
  }

  console.log('[vscode-diff-mcp] Extension activated successfully');
}

export function deactivate(): void {
  console.log('[vscode-diff-mcp] Deactivating extension...');
  statusBarItem?.dispose();
  statusBarItem = undefined;
  stateManager?.dispose();
  stateManager = undefined;
  mcpHttpServer?.close();
  mcpHttpServer = undefined;
}
