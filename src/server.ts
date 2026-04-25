import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import * as vscode from 'vscode';
import * as path from 'path';
import * as http from 'http';
import { StateManager } from './state-manager';

export function createMcpServer(stateManager: StateManager): McpServer {
  const server = new McpServer({
    name: 'vscode-diff-mcp',
    version: '0.1.0',
  });

  function getConfig() {
    const cfg = vscode.workspace.getConfiguration('aiDiffReview');
    return {
      diagnosticsWaitMs: cfg.get<number>('diagnosticsWaitMs', 500),
      maxDiagnosticsPerEdit: cfg.get<number>('maxDiagnosticsPerEdit', 10),
    };
  }

  function resolveAbsolutePath(filePath: string, workspaceRoot: string): string {
    return path.isAbsolute(filePath) ? filePath : path.join(workspaceRoot, filePath);
  }

  function getWorkspaceRoot(): string | null {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null;
  }

  async function finishEditAndReport(
    absolutePath: string,
    change: import('./types').PendingChange,
    successMessage: string
  ) {
    const backupUri = stateManager.getBackupUri(change.id);
    const fileUri = vscode.Uri.file(absolutePath);
    const diffTitle = `AI Edit: ${path.basename(absolutePath)} [${change.id.slice(0, 8)}]`;

    if (backupUri) {
      await vscode.commands.executeCommand('vscode.diff', backupUri, fileUri, diffTitle);
    } else {
      await vscode.window.showTextDocument(fileUri);
    }

    await vscode.commands.executeCommand('pendingAiChanges.focus');

    const { collectDiagnostics } = await import('./diagnostics.js');
    const { diagnosticsWaitMs, maxDiagnosticsPerEdit } = getConfig();
    const { errors, warnings } = await collectDiagnostics(absolutePath, diagnosticsWaitMs);

    let diagText = '';
    if (errors.length > 0 || warnings.length > 0) {
      diagText = `\n\n⚠️ ${errors.length + warnings.length} diagnostic issue(s) detected after your edit:\n`;
      const all = [...errors, ...warnings];
      diagText += all.slice(0, maxDiagnosticsPerEdit).map(d => `  Line ${d.line}: [${d.severity}] ${d.message} (${d.source || ''})`).join('\n');
      if (all.length > maxDiagnosticsPerEdit) diagText += `\n  ... and ${all.length - maxDiagnosticsPerEdit} more.`;
    }

    return {
      content: [
        {
          type: 'text' as const,
          text: [
            `✅ ${successMessage}`,
            `File: ${absolutePath}`,
            `Change ID: ${change.id}`,
            ``,
            `A diff view has been opened in VS Code for user review.`,
            `Waiting for the user to Accept or Reject this change.${diagText}`,
          ].join('\n'),
        },
      ],
    };
  }

  // ─────────────────────────────────────────────────────────
  // Tool: read_file
  // ─────────────────────────────────────────────────────────
  server.registerTool(
    'read_file',
    {
      title: 'Read File',
      description: `Read the content of a file. Reads the in-memory editor buffer first (captures unsaved changes),
falling back to disk. Use this before edit_block to get the current exact content.`,
      inputSchema: {
        filePath: z.string().describe('Absolute or workspace-relative file path'),
        startLine: z.number().optional().describe('First line to return (1-indexed, inclusive). Omit for full file.'),
        endLine: z.number().optional().describe('Last line to return (1-indexed, inclusive). Omit for full file.'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ filePath, startLine, endLine }) => {
      const workspaceRoot = getWorkspaceRoot();
      if (!workspaceRoot) {
        return { content: [{ type: 'text' as const, text: 'Error: No workspace folder open.' }], isError: true };
      }
      const absolutePath = resolveAbsolutePath(filePath, workspaceRoot);

      try {
        const uri = vscode.Uri.file(absolutePath);
        const doc = await vscode.workspace.openTextDocument(uri);
        const fullText = doc.getText();

        if (startLine !== undefined || endLine !== undefined) {
          const lines = fullText.split('\n');
          const total = lines.length;
          const from = Math.max(1, startLine ?? 1) - 1;
          const to = Math.min(total, endLine ?? total);
          const slice = lines.slice(from, to).join('\n');
          return {
            content: [{
              type: 'text' as const,
              text: `File: ${absolutePath}\nLines ${from + 1}-${to} of ${total}:\n\n${slice}`,
            }],
          };
        }

        return {
          content: [{
            type: 'text' as const,
            text: `File: ${absolutePath}\nLines: ${doc.lineCount}\n\n${fullText}`,
          }],
        };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: `Error reading file: ${err}` }], isError: true };
      }
    }
  );

  // ─────────────────────────────────────────────────────────
  // Tool: list_files
  // ─────────────────────────────────────────────────────────
  server.registerTool(
    'list_files',
    {
      title: 'List Files',
      description: `List files in the workspace matching a glob pattern.
Use this to explore the project structure before reading or editing files.
Examples: "**/*.ts", "src/**/*.{ts,tsx}", "*.json"`,
      inputSchema: {
        pattern: z.string().default('**/*').describe('Glob pattern relative to workspace root (default: **/* lists all files)'),
        excludePattern: z.string().optional().describe('Glob pattern to exclude (default excludes node_modules, .git, out, dist)'),
        maxResults: z.number().default(200).describe('Maximum number of results to return (default 200)'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ pattern, excludePattern, maxResults }) => {
      const workspaceRoot = getWorkspaceRoot();
      if (!workspaceRoot) {
        return { content: [{ type: 'text' as const, text: 'Error: No workspace folder open.' }], isError: true };
      }

      try {
        const exclude = excludePattern ?? '{**/node_modules/**,**/.git/**,**/out/**,**/dist/**,**/.vscode/mcp-diff-state/**}';
        const uris = await vscode.workspace.findFiles(pattern, exclude, maxResults);

        if (uris.length === 0) {
          return { content: [{ type: 'text' as const, text: `No files found matching: ${pattern}` }] };
        }

        const lines = uris
          .map(u => path.relative(workspaceRoot, u.fsPath).replace(/\\/g, '/'))
          .sort()
          .join('\n');

        return {
          content: [{
            type: 'text' as const,
            text: `Files matching "${pattern}" (${uris.length}${uris.length === maxResults ? '+' : ''}):\n\n${lines}`,
          }],
        };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: `Error listing files: ${err}` }], isError: true };
      }
    }
  );

  // ─────────────────────────────────────────────────────────
  // Tool: get_diagnostics
  // ─────────────────────────────────────────────────────────
  server.registerTool(
    'get_diagnostics',
    {
      title: 'Get Diagnostics',
      description: `Get current TypeScript/ESLint/language server errors and warnings for a file or the entire workspace.
Use this to check the health of the codebase before or after edits, without making any changes.`,
      inputSchema: {
        filePath: z.string().optional().describe('File to check. Omit to get diagnostics for ALL workspace files.'),
        severity: z.enum(['all', 'errors_only', 'warnings_only']).default('all').describe('Filter by severity (default: all)'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ filePath, severity }) => {
      const workspaceRoot = getWorkspaceRoot();
      if (!workspaceRoot) {
        return { content: [{ type: 'text' as const, text: 'Error: No workspace folder open.' }], isError: true };
      }

      try {
        const { collectDiagnostics } = await import('./diagnostics.js');

        if (filePath) {
          const absolutePath = resolveAbsolutePath(filePath, workspaceRoot);
          const { errors, warnings } = await collectDiagnostics(absolutePath, 0);
          return formatDiagnosticsResult([{ file: absolutePath, errors, warnings }], severity, workspaceRoot);
        }

        // Workspace-wide diagnostics via VS Code API
        const allDiags = vscode.languages.getDiagnostics();
        const results = allDiags
          .filter(([, diags]) => diags.length > 0)
          .map(([uri, diags]) => {
            const errors = diags
              .filter(d => d.severity === vscode.DiagnosticSeverity.Error)
              .map(d => ({
                line: d.range.start.line + 1,
                column: d.range.start.character + 1,
                severity: 'error' as const,
                message: d.message,
                source: d.source,
                code: typeof d.code === 'object' ? String(d.code.value) : String(d.code || ''),
              }));
            const warnings = diags
              .filter(d => d.severity === vscode.DiagnosticSeverity.Warning)
              .map(d => ({
                line: d.range.start.line + 1,
                column: d.range.start.character + 1,
                severity: 'warning' as const,
                message: d.message,
                source: d.source,
                code: typeof d.code === 'object' ? String(d.code.value) : String(d.code || ''),
              }));
            return { file: uri.fsPath, errors, warnings };
          });

        return formatDiagnosticsResult(results, severity, workspaceRoot);
      } catch (err) {
        return { content: [{ type: 'text' as const, text: `Error getting diagnostics: ${err}` }], isError: true };
      }
    }
  );

  // ─────────────────────────────────────────────────────────
  // Tool: delete_file
  // ─────────────────────────────────────────────────────────
  server.registerTool(
    'delete_file',
    {
      title: 'Delete File',
      description: `Delete a file from the workspace. The deletion is tracked as a pending change shown in the diff panel.
The user must Accept the deletion or Reject it (which restores the file from backup).`,
      inputSchema: {
        filePath: z.string().describe('Absolute or workspace-relative file path to delete'),
        description: z.string().optional().describe('Reason for deletion'),
        conversationId: z.string().optional().describe('ID of current AI conversation'),
      },
      annotations: { destructiveHint: true },
    },
    async ({ filePath, description, conversationId }) => {
      const workspaceRoot = getWorkspaceRoot();
      if (!workspaceRoot) {
        return { content: [{ type: 'text' as const, text: 'Error: No workspace folder open.' }], isError: true };
      }
      const absolutePath = resolveAbsolutePath(filePath, workspaceRoot);

      try {
        const change = await stateManager.trackFileOperation(
          absolutePath,
          async () => {
            await vscode.workspace.fs.delete(vscode.Uri.file(absolutePath));
          },
          'write_file',
          description ?? `Delete ${path.basename(absolutePath)}`,
          conversationId
        );

        await vscode.commands.executeCommand('pendingAiChanges.focus');

        return {
          content: [{
            type: 'text' as const,
            text: [
              `✅ File queued for deletion: ${absolutePath}`,
              `Change ID: ${change.id}`,
              ``,
              `The file has been deleted. The user can Reject this change to restore it.`,
            ].join('\n'),
          }],
        };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: `Error deleting file: ${err}` }], isError: true };
      }
    }
  );

  // ─────────────────────────────────────────────────────────
  // Tool: rename_file
  // ─────────────────────────────────────────────────────────
  server.registerTool(
    'rename_file',
    {
      title: 'Rename / Move File',
      description: `Rename or move a file within the workspace. Uses VS Code's WorkspaceEdit API so the operation
is visible in the editor. The original path is backed up so the user can Reject to undo.`,
      inputSchema: {
        oldPath: z.string().describe('Current file path (absolute or workspace-relative)'),
        newPath: z.string().describe('New file path (absolute or workspace-relative)'),
        description: z.string().optional().describe('Reason for the rename/move'),
        conversationId: z.string().optional().describe('ID of current AI conversation'),
      },
      annotations: { destructiveHint: false },
    },
    async ({ oldPath, newPath, description, conversationId }) => {
      const workspaceRoot = getWorkspaceRoot();
      if (!workspaceRoot) {
        return { content: [{ type: 'text' as const, text: 'Error: No workspace folder open.' }], isError: true };
      }
      const absoluteOldPath = resolveAbsolutePath(oldPath, workspaceRoot);
      const absoluteNewPath = resolveAbsolutePath(newPath, workspaceRoot);

      try {
        const change = await stateManager.trackFileOperation(
          absoluteOldPath,
          async () => {
            const edit = new vscode.WorkspaceEdit();
            edit.renameFile(
              vscode.Uri.file(absoluteOldPath),
              vscode.Uri.file(absoluteNewPath),
              { overwrite: false }
            );
            const ok = await vscode.workspace.applyEdit(edit);
            if (!ok) throw new Error('WorkspaceEdit.renameFile returned false');
          },
          'write_file',
          description ?? `Rename ${path.basename(absoluteOldPath)} → ${path.basename(absoluteNewPath)}`,
          conversationId
        );

        await vscode.commands.executeCommand('pendingAiChanges.focus');

        return {
          content: [{
            type: 'text' as const,
            text: [
              `✅ File renamed/moved successfully.`,
              `From: ${absoluteOldPath}`,
              `To:   ${absoluteNewPath}`,
              `Change ID: ${change.id}`,
              ``,
              `The user can Reject this change to restore the original filename.`,
            ].join('\n'),
          }],
        };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: `Error renaming file: ${err}` }], isError: true };
      }
    }
  );

  // ─────────────────────────────────────────────────────────
  // Tool: write_file
  // ─────────────────────────────────────────────────────────
  server.registerTool(
    'write_file',
    {
      title: 'Write File',
      description: `Write or append complete content to a file.
Use this if you are replacing the ENTIRE file or appending to it.
For smaller, surgical fixes in large files, use edit_block instead.
Saves state, backups original, and opens diff reviewer.`,
      inputSchema: {
        filePath: z.string().describe('Absolute or workspace-relative file path'),
        content: z.string().describe('Content to write'),
        mode: z.enum(['rewrite', 'append']).default('rewrite').describe('rewrite (default) or append'),
        description: z.string().optional().describe('Description of the edit'),
        conversationId: z.string().optional().describe('ID of current AI conversation'),
      },
      annotations: { destructiveHint: false },
    },
    async ({ filePath, content, mode, description, conversationId }) => {
      const workspaceRoot = getWorkspaceRoot();
      if (!workspaceRoot) {
        return { content: [{ type: 'text' as const, text: 'Error: No workspace folder open.' }], isError: true };
      }
      const absolutePath = resolveAbsolutePath(filePath, workspaceRoot);

      try {
        const { writeFileContent } = await import('./file-edit-engine.js');
        const change = await stateManager.trackFileOperation(
          absolutePath,
          async () => { await writeFileContent(absolutePath, content, mode); },
          'write_file',
          description,
          conversationId
        );
        return await finishEditAndReport(absolutePath, change, `File written successfully (${mode}).`);
      } catch (err) {
        return { content: [{ type: 'text' as const, text: `Error writing file: ${err}` }], isError: true };
      }
    }
  );

  // ─────────────────────────────────────────────────────────
  // Tool: edit_block
  // ─────────────────────────────────────────────────────────
  server.registerTool(
    'edit_block',
    {
      title: 'Edit Block',
      description: `Apply one or more surgical edits to a file in a single call.

IMPORTANT: Always call read_file first to get the exact current content and line numbers.

Each edit requires:
  - startLine: the line where oldString begins (1-indexed). Used to verify the user
    hasn't changed that region since you read the file. Only the content at that exact
    line position is checked — no full-file scan.
  - oldString: exact text starting at startLine. If it doesn't match, the actual
    content at that line is returned so you can self-correct.
  - newString: replacement text.

Pass multiple edits in the 'edits' array to change several places in one call.
All edits on the same file are grouped into a single diff entry for the user.`,
      inputSchema: {
        filePath: z.string().describe('Absolute or workspace-relative file path'),
        edits: z.array(z.object({
          oldString: z.string().describe('Exact text to replace, starting at startLine.'),
          newString: z.string().describe('Replacement text.'),
          startLine: z.number().describe('Line number where oldString begins (1-indexed).'),
        })).min(1).describe('List of edits to apply. Applied in startLine order.'),
        description: z.string().optional(),
        conversationId: z.string().optional(),
      },
      annotations: { destructiveHint: false },
    },
    async ({ filePath, edits, description, conversationId }) => {
      const workspaceRoot = getWorkspaceRoot();
      if (!workspaceRoot) {
        return { content: [{ type: 'text' as const, text: 'Error: No workspace folder open.' }], isError: true };
      }
      const absolutePath = resolveAbsolutePath(filePath, workspaceRoot);

      let operationResult: any;

      try {
        const { performBatchLineAnchoredReplace } = await import('./file-edit-engine.js');

        const change = await stateManager.trackFileOperation(
          absolutePath,
          async () => {
            operationResult = await performBatchLineAnchoredReplace(absolutePath, edits);
            if (!operationResult.success) {
              const failures = operationResult.results
                .map((r: any) => `Edit ${r.editIndex + 1} (startLine ${edits[r.editIndex]?.startLine}): ${r.message}`)
                .join('\n\n');
              throw new Error(failures);
            }
          },
          'edit_block',
          description,
          conversationId
        );

        const locations = edits.map(e => `line ${e.startLine}`).join(', ');
        return await finishEditAndReport(absolutePath, change, `${edits.length} edit(s) applied successfully (${locations}).`);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text' as const, text: errMsg }], isError: true };
      }
    }
  );

  // ─────────────────────────────────────────────────────────
  // Tool: search_in_files
  // ─────────────────────────────────────────────────────────
  server.registerTool(
    'search_in_files',
    {
      title: 'Search in Files',
      description: `Search for a literal string or regex pattern across workspace files.
Returns file paths and matching line numbers. Use this to locate code before reading or editing.
Examples: find all usages of a function, locate an import, find a config key.`,
      inputSchema: {
        pattern: z.string().describe('Text to search for (literal string or regex if isRegex is true)'),
        isRegex: z.boolean().default(false).describe('Treat pattern as a regular expression (default: false)'),
        fileGlob: z.string().default('**/*').describe('Glob pattern to restrict which files are searched (e.g. "**/*.ts")'),
        excludeGlob: z.string().optional().describe('Glob pattern to exclude (default excludes node_modules, .git, out, dist)'),
        maxResults: z.number().default(100).describe('Maximum total matches to return (default 100)'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ pattern, isRegex, fileGlob, excludeGlob, maxResults }) => {
      const workspaceRoot = getWorkspaceRoot();
      if (!workspaceRoot) {
        return { content: [{ type: 'text' as const, text: 'Error: No workspace folder open.' }], isError: true };
      }

      try {
        const exclude = excludeGlob ?? '{**/node_modules/**,**/.git/**,**/out/**,**/dist/**,**/.vscode/mcp-diff-state/**}';
        const uris = await vscode.workspace.findFiles(fileGlob, exclude, 500);

        const { searchInFile } = await import('./file-edit-engine.js');

        const output: string[] = [];
        let totalMatches = 0;

        for (const uri of uris) {
          if (totalMatches >= maxResults) break;
          const matches = await searchInFile(uri.fsPath, pattern, isRegex);
          if (matches.length === 0) continue;

          const rel = path.relative(workspaceRoot, uri.fsPath).replace(/\\/g, '/');
          output.push(`📄 ${rel}`);
          for (const m of matches) {
            if (totalMatches >= maxResults) { output.push('  ... (limit reached)'); break; }
            output.push(`  Line ${m.line}:${m.column}  ${m.text.trim()}`);
            totalMatches++;
          }
        }

        if (output.length === 0) {
          return { content: [{ type: 'text' as const, text: `No matches found for: ${pattern}` }] };
        }

        return {
          content: [{
            type: 'text' as const,
            text: `Search results for "${pattern}" (${totalMatches} match${totalMatches === 1 ? '' : 'es'}):\n\n${output.join('\n')}`,
          }],
        };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: `Error searching files: ${err}` }], isError: true };
      }
    }
  );

  // ─────────────────────────────────────────────────────────
  // Tool: get_open_editors
  // ─────────────────────────────────────────────────────────
  server.registerTool(
    'get_open_editors',
    {
      title: 'Get Open Editors',
      description: `List all files currently open in VS Code editor tabs.
Returns file paths grouped by tab group, with the active (focused) file marked.
Use this to understand what the user is currently looking at.`,
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      const workspaceRoot = getWorkspaceRoot();

      const activeUri = vscode.window.activeTextEditor?.document.uri.fsPath;
      const lines: string[] = [];

      const tabGroups = vscode.window.tabGroups.all;
      for (const group of tabGroups) {
        if (tabGroups.length > 1) {
          lines.push(`── Tab Group ${group.viewColumn} ──`);
        }
        for (const tab of group.tabs) {
          const input = tab.input;
          let filePath: string | undefined;

          if (input instanceof vscode.TabInputText) {
            filePath = input.uri.fsPath;
          } else if (input instanceof vscode.TabInputTextDiff) {
            filePath = input.modified.fsPath;
          }

          if (!filePath) continue;

          const rel = workspaceRoot
            ? path.relative(workspaceRoot, filePath).replace(/\\/g, '/')
            : filePath;

          const isActive = filePath === activeUri;
          const isDirty = tab.isDirty ? ' [unsaved]' : '';
          const marker = isActive ? '▶ ' : '  ';
          lines.push(`${marker}${rel}${isDirty}`);
        }
      }

      if (lines.length === 0) {
        return { content: [{ type: 'text' as const, text: 'No files currently open in the editor.' }] };
      }

      return {
        content: [{
          type: 'text' as const,
          text: `Open editors (▶ = active):\n\n${lines.join('\n')}`,
        }],
      };
    }
  );

  // ─────────────────────────────────────────────────────────
  // Tool: get_pending_changes
  // ─────────────────────────────────────────────────────────
  server.registerTool(
    'get_pending_changes',
    {
      title: 'Get Pending Changes',
      description: 'List all currently pending (user-unreviewed) AI file changes.',
      inputSchema: {
        conversationId: z.string().optional().describe('Filter by conversation ID (optional)'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ conversationId }) => {
      let pending = stateManager.getAllPending();
      if (conversationId) {
        pending = pending.filter(c => c.conversationId === conversationId);
      }

      if (pending.length === 0) {
        return { content: [{ type: 'text' as const, text: 'No pending AI changes.' }] };
      }

      const lines = pending.map((c, i) =>
        [
          `${i + 1}. [${c.id.slice(0, 8)}] ${c.filePath}`,
          `   Time: ${c.timestamp}`,
          c.description ? `   Description: ${c.description}` : null,
          c.conversationId ? `   Conversation: ${c.conversationId}` : null,
        ]
          .filter(Boolean)
          .join('\n')
      );

      return {
        content: [{
          type: 'text' as const,
          text: `Pending AI changes (${pending.length}):\n\n${lines.join('\n\n')}`,
        }],
      };
    }
  );

  // ─────────────────────────────────────────────────────────
  // Tool: read_rejected_changes
  // ─────────────────────────────────────────────────────────
  server.registerTool(
    'read_rejected_changes',
    {
      title: 'Read Rejected Changes',
      description: `Read the log of changes that the user rejected.

Use this to understand what the user disliked and avoid making the same mistakes.
Each rejection includes the original content, the rejected AI content, and an optional reason.`,
      inputSchema: {
        limit: z.number().optional().default(10).describe('Max number of rejections to return (default 10)'),
        conversationId: z.string().optional().describe('Filter by conversation ID (optional)'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ limit, conversationId }) => {
      let rejected = stateManager.getRejectedChanges(limit ?? 10);
      if (conversationId) {
        rejected = rejected.filter(r => r.conversationId === conversationId);
      }

      if (rejected.length === 0) {
        return { content: [{ type: 'text' as const, text: 'No rejected changes found.' }] };
      }

      const lines = rejected.map((r, i) =>
        [
          `--- Rejection ${i + 1} ---`,
          `ID: ${r.id.slice(0, 8)}`,
          `File: ${r.filePath}`,
          `Time: ${r.timestamp}`,
          r.reason ? `Reason: ${r.reason}` : 'Reason: (not provided)',
          r.description ? `Description: ${r.description}` : null,
          ``,
          `=== Original Content (what was restored) ===`,
          r.originalContent.slice(0, 500) + (r.originalContent.length > 500 ? '\n...(truncated)' : ''),
          ``,
          `=== Rejected Content (what AI wrote) ===`,
          r.rejectedContent.slice(0, 500) + (r.rejectedContent.length > 500 ? '\n...(truncated)' : ''),
        ]
          .filter(line => line !== null)
          .join('\n')
      );

      return {
        content: [{
          type: 'text' as const,
          text: `Rejected changes (${rejected.length}):\n\n${lines.join('\n\n')}`,
        }],
      };
    }
  );

  return server;
}

function formatDiagnosticsResult(
  results: Array<{ file: string; errors: any[]; warnings: any[] }>,
  severity: 'all' | 'errors_only' | 'warnings_only',
  workspaceRoot: string
): { content: Array<{ type: 'text'; text: string }> } {
  const filtered = results.map(r => ({
    file: r.file,
    errors: severity === 'warnings_only' ? [] : r.errors,
    warnings: severity === 'errors_only' ? [] : r.warnings,
  })).filter(r => r.errors.length > 0 || r.warnings.length > 0);

  if (filtered.length === 0) {
    return { content: [{ type: 'text' as const, text: '✅ No diagnostics found.' }] };
  }

  const totalErrors = filtered.reduce((n, r) => n + r.errors.length, 0);
  const totalWarnings = filtered.reduce((n, r) => n + r.warnings.length, 0);

  const lines: string[] = [`Diagnostics: ${totalErrors} error(s), ${totalWarnings} warning(s)\n`];

  for (const r of filtered) {
    const rel = path.relative(workspaceRoot, r.file).replace(/\\/g, '/');
    const all = [...r.errors, ...r.warnings];
    lines.push(`📄 ${rel}`);
    for (const d of all) {
      lines.push(`  Line ${d.line}:${d.column} [${d.severity}] ${d.message}${d.source ? ` (${d.source})` : ''}`);
    }
  }

  return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
}

/**
 * Start the MCP server using Streamable HTTP transport (MCP SDK 1.x / 2025-03-26 protocol).
 *
 * VS Code owns the extension host's stdio, so we use HTTP instead.
 * Antigravity connects via a single HTTP endpoint (POST = request, GET = notification stream).
 *
 * MCP client configuration (mcp_config.json):
 * {
 *   "vscode-diff-mcp": {
 *     "serverUrl": "http://127.0.0.1:6070/mcp"
 *   }
 * }
 */
export async function startMcpServer(
  stateManager: StateManager,
  port = 6070
): Promise<{ server: McpServer; httpServer: http.Server }> {
  const mcpServer = createMcpServer(stateManager);

  const transports = new Map<string, StreamableHTTPServerTransport>();

  const httpServer = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);

    if (req.method === 'GET' && url.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', name: 'vscode-diff-mcp', version: '0.1.0', port }));
      return;
    }

    if (url.pathname === '/mcp') {
      if (req.method === 'DELETE') {
        const sessionId = req.headers['mcp-session-id'] as string | undefined;
        if (sessionId) {
          const transport = transports.get(sessionId);
          if (transport) {
            await transport.close();
            transports.delete(sessionId);
          }
        }
        res.writeHead(200).end();
        return;
      }

      if (req.method === 'POST' || req.method === 'GET') {
        const sessionId = req.headers['mcp-session-id'] as string | undefined;
        let transport: StreamableHTTPServerTransport;

        if (sessionId && transports.has(sessionId)) {
          transport = transports.get(sessionId)!;
        } else if (!sessionId && req.method === 'POST') {
          transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => crypto.randomUUID(),
            onsessioninitialized: (id) => {
              transports.set(id, transport);
            },
          });

          transport.onclose = () => {
            if (transport.sessionId) {
              transports.delete(transport.sessionId);
            }
          };

          await mcpServer.connect(transport);
        } else {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Bad Request: missing or invalid session ID' }));
          return;
        }

        await transport.handleRequest(req, res);
        return;
      }
    }

    res.writeHead(404).end();
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.listen(port, '127.0.0.1', () => {
      console.log(`[vscode-diff-mcp] MCP server (Streamable HTTP) listening on http://127.0.0.1:${port}/mcp`);
      resolve();
    });
    httpServer.on('error', reject);
  });

  return { server: mcpServer, httpServer };
}
