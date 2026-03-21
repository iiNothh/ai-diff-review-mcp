import * as vscode from 'vscode';
import * as path from 'path';
import { StateManager } from './state-manager';

/**
 * Register all accept / reject / openDiff commands with VS Code.
 */
export function registerCommands(
  context: vscode.ExtensionContext,
  stateManager: StateManager
): void {

  // ── Open Diff ──────────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand('vscode-diff-mcp.openDiff', async (arg: any) => {
      const changeId = typeof arg === 'string' ? arg : arg?.changeId;
      if (!changeId) return;
      const change = stateManager.getPendingById(changeId);
      if (!change) {
        vscode.window.showWarningMessage('Change not found or already resolved.');
        return;
      }
      const backupUri = stateManager.getBackupUri(changeId);
      const fileUri = vscode.Uri.file(change.filePath);
      const diffTitle = `AI Edit: ${path.basename(change.filePath)} [${changeId.slice(0, 8)}]`;

      if (backupUri) {
        await vscode.commands.executeCommand('vscode.diff', backupUri, fileUri, diffTitle);
      } else {
        await vscode.window.showTextDocument(fileUri);
      }
    })
  );

  // ── Accept ─────────────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand('vscode-diff-mcp.accept', async (arg: any) => {
      const changeId = typeof arg === 'string' ? arg : arg?.changeId;
      if (!changeId) return;
      const change = stateManager.getPendingById(changeId);
      if (!change) {
        vscode.window.showWarningMessage('Change not found or already resolved.');
        return;
      }

      try {
        stateManager.acceptChange(changeId);

        // Close the diff editor for this file if open
        await closeDiffEditorForFile(change.filePath);

        vscode.window.showInformationMessage(
          `✅ Accepted: ${path.basename(change.filePath)}`
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        vscode.window.showErrorMessage(`Failed to accept change: ${msg}`);
      }
    })
  );

  // ── Reject ─────────────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand('vscode-diff-mcp.reject', async (arg: any) => {
      const changeId = typeof arg === 'string' ? arg : arg?.changeId;
      if (!changeId) return;
      const change = stateManager.getPendingById(changeId);
      if (!change) {
        vscode.window.showWarningMessage('Change not found or already resolved.');
        return;
      }

      // Ask for optional rejection reason
      const reason = await vscode.window.showInputBox({
        title: `Reject: ${path.basename(change.filePath)}`,
        prompt: 'Why are you rejecting this change? (optional)',
        placeHolder: 'Leave blank to reject without a reason',
      });

      // User pressed Escape — abort rejection
      if (reason === undefined) return;

      try {
        const { conflictDetected } = await stateManager.rejectChange(changeId, reason || undefined);

        if (conflictDetected) {
          vscode.window.showWarningMessage(
            `⚠️ Conflict: The file was modified after the AI edit. ` +
            `The original (pre-AI) version has been restored, which may have overwritten your manual changes.`
          );
        } else {
          vscode.window.showInformationMessage(
            `❌ Rejected: ${path.basename(change.filePath)} — original restored.`
          );
        }

        // Close the diff editor
        await closeDiffEditorForFile(change.filePath);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        vscode.window.showErrorMessage(`Failed to reject change: ${msg}`);
      }
    })
  );

  // ── Accept All ─────────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand('vscode-diff-mcp.acceptAll', async () => {
      const pending = stateManager.getAllPending();
      if (pending.length === 0) {
        vscode.window.showInformationMessage('No pending AI changes.');
        return;
      }

      const confirmed = await vscode.window.showQuickPick(['Yes, accept all', 'Cancel'], {
        title: `Accept all ${pending.length} pending AI changes?`,
      });
      if (confirmed !== 'Yes, accept all') return;

      let accepted = 0;
      for (const change of pending) {
        try {
          stateManager.acceptChange(change.id);
          await closeDiffEditorForFile(change.filePath);
          accepted++;
        } catch {
          // Continue with others
        }
      }
      vscode.window.showInformationMessage(`✅ Accepted ${accepted} AI changes.`);
    })
  );

  // ── Reject All ─────────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand('vscode-diff-mcp.rejectAll', async () => {
      const pending = stateManager.getAllPending();
      if (pending.length === 0) {
        vscode.window.showInformationMessage('No pending AI changes.');
        return;
      }

      const reason = await vscode.window.showInputBox({
        title: `Reject all ${pending.length} pending AI changes`,
        prompt: 'Reason for rejecting all? (optional)',
        placeHolder: 'Leave blank to reject without a reason',
      });
      if (reason === undefined) return; // Escape pressed

      let rejected = 0;
      let conflicts = 0;
      for (const change of pending) {
        try {
          const { conflictDetected } = await stateManager.rejectChange(change.id, reason || undefined);
          if (conflictDetected) conflicts++;
          await closeDiffEditorForFile(change.filePath);
          rejected++;
        } catch {
          // Continue with others
        }
      }

      let msg = `❌ Rejected ${rejected} AI changes. All originals restored.`;
      if (conflicts > 0) msg += ` ⚠️ ${conflicts} file(s) had conflicts (manual edits may be lost).`;
      vscode.window.showInformationMessage(msg);
    })
  );
}

/**
 * Close any open diff editor tab that targets the given file URI.
 */
async function closeDiffEditorForFile(filePath: string): Promise<void> {
  const fileUri = vscode.Uri.file(filePath).toString();
  for (const tabGroup of vscode.window.tabGroups.all) {
    for (const tab of tabGroup.tabs) {
      const input = tab.input;
      if (input instanceof vscode.TabInputTextDiff) {
        if (input.modified.toString() === fileUri) {
          await vscode.window.tabGroups.close(tab, true);
        }
      }
    }
  }
}
