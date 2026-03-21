import * as vscode from 'vscode';
import { StateManager } from './state-manager';
import { PendingChangesProvider } from './tree-view';
import { registerCommands } from './commands';
import { startMcpServer } from './server';
import * as http from 'http';

let mcpHttpServer: http.Server | undefined;
let stateManager: StateManager | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  console.log('[vscode-diff-mcp] Activating extension...');

  // Require an open workspace
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

  // Update sidebar badge with pending count
  const updateBadge = () => {
    const count = stateManager!.getAllPending().length;
    treeView.badge = count > 0
      ? { value: count, tooltip: `${count} pending AI change${count === 1 ? '' : 's'}` }
      : undefined;
  };
  stateManager.onDidChange(updateBadge);
  updateBadge();

  context.subscriptions.push(treeView);
  context.subscriptions.push(treeProvider);

  // ── Commands ──────────────────────────────────────────────
  registerCommands(context, stateManager);

  // ── MCP Server ────────────────────────────────────────────
  // Only start the MCP server when running in a context that has stdio
  // (i.e., when launched as an MCP server process, not a normal VS Code window).
  // We use the presence of the env variable to gate this.
  // Start MCP server on HTTP+SSE transport (port 6070 by default)
  try {
    const result = await startMcpServer(stateManager, 6070);
    mcpHttpServer = result.httpServer;
    console.log('[vscode-diff-mcp] MCP server started — http://127.0.0.1:6070/sse');
  } catch (err) {
    console.error('[vscode-diff-mcp] Failed to start MCP server:', err);
    vscode.window.showErrorMessage(
      `AI Diff Review: MCP server failed to start — ${err instanceof Error ? err.message : err}`
    );
  }

  console.log('[vscode-diff-mcp] Extension activated successfully');
  vscode.window.showInformationMessage('AI Diff Review (MCP) is active ✅');
}

export function deactivate(): void {
  console.log('[vscode-diff-mcp] Deactivating extension...');
  stateManager?.dispose();
  stateManager = undefined;
  mcpHttpServer?.close();
  mcpHttpServer = undefined;
}
