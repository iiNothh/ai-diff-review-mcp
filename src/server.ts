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

  // Helper to open diff and run diagnostics
  async function finishEditAndReport(
    absolutePath: string, 
    change: import('./types').PendingChange, 
    successMessage: string
  ) {
    // Open the diff view in VS Code
    const backupUri = stateManager.getBackupUri(change.id);
    const fileUri = vscode.Uri.file(absolutePath);
    const diffTitle = `AI Edit: ${path.basename(absolutePath)} [${change.id.slice(0, 8)}]`;

    if (backupUri) {
      await vscode.commands.executeCommand('vscode.diff', backupUri, fileUri, diffTitle);
    } else {
      await vscode.window.showTextDocument(fileUri);
    }

    // Focus the pending changes sidebar
    await vscode.commands.executeCommand('pendingAiChanges.focus');

    // Run diagnostics
    const { collectDiagnostics } = await import('./diagnostics.js');
    const { errors, warnings } = await collectDiagnostics(absolutePath);
    
    let diagText = "";
    if (errors.length > 0 || warnings.length > 0) {
      diagText = `\n\n⚠️ ${errors.length + warnings.length} diagnostic issue(s) detected after your edit:\n`;
      const all = [...errors, ...warnings];
      diagText += all.slice(0, 10).map(d => `  Line ${d.line}: [${d.severity}] ${d.message} (${d.source || ''})`).join('\n');
      if (all.length > 10) diagText += `\n  ... and ${all.length - 10} more.`;
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
  // Tool: write_file
  // ─────────────────────────────────────────────────────────
  server.tool(
    'write_file',
    `Write or append complete content to a file. 
    Use this if you are replacing the ENTIRE file or appending to it. 
    For smaller, surgical fixes in large files, use edit_block instead.
    Saves state, backups original, and opens diff reviewer.`,
    {
      filePath: z.string().describe('Absolute or workspace-relative file path'),
      content: z.string().describe('Content to write'),
      mode: z.enum(['rewrite', 'append']).default('rewrite').describe('rewrite (default) or append'),
      description: z.string().optional().describe('Description of the edit'),
      conversationId: z.string().optional().describe('ID of current AI conversation'),
    },
    async ({ filePath, content, mode, description, conversationId }) => {
      const workspaceFolders = vscode.workspace.workspaceFolders;
      if (!workspaceFolders?.length) {
        return { content: [{ type: 'text' as const, text: 'Error: No workspace folder open.' }], isError: true };
      }
      const workspaceRoot = workspaceFolders[0].uri.fsPath;
      const absolutePath = path.isAbsolute(filePath) ? filePath : path.join(workspaceRoot, filePath);

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
  server.tool(
    'edit_block',
    `Apply a surgical find-and-replace edit to a file. 
    Finds exact 'oldString' and replaces with 'newString'.
    If exact match fails, fuzzy search automatically detects close matches and informs you.
    Can be called multiple times on the same file; changes will be grouped in one diff.`,
    {
      filePath: z.string().describe('Absolute or workspace-relative file path'),
      oldString: z.string().describe('String to find and replace. Must match the target file exactly (or closely for fuzzy).'),
      newString: z.string().describe('Replacement string.'),
      expectedReplacements: z.number().default(1).describe('How many occurrences are expected to be replaced (default 1)'),
      description: z.string().optional(),
      conversationId: z.string().optional(),
    },
    async ({ filePath, oldString, newString, expectedReplacements, description, conversationId }) => {
      const workspaceFolders = vscode.workspace.workspaceFolders;
      if (!workspaceFolders?.length) {
        return { content: [{ type: 'text' as const, text: 'Error: No workspace folder open.' }], isError: true };
      }
      const workspaceRoot = workspaceFolders[0].uri.fsPath;
      const absolutePath = path.isAbsolute(filePath) ? filePath : path.join(workspaceRoot, filePath);

      let operationResult: any;

      try {
        const { performSearchReplace } = await import('./file-edit-engine.js');
        
        const change = await stateManager.trackFileOperation(
          absolutePath,
          async () => {
            operationResult = await performSearchReplace(absolutePath, oldString, newString, expectedReplacements);
            if (!operationResult.success) {
                throw new Error(operationResult.message);
            }
          },
          'edit_block',
          description,
          conversationId
        );
        
        return await finishEditAndReport(absolutePath, change, `Edit block applied successfully.`);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text' as const, text: `${errMsg}` }], isError: true };
      }
    }
  );

  // ─────────────────────────────────────────────────────────
  // Tool: get_pending_changes
  // ─────────────────────────────────────────────────────────
  server.tool(
    'get_pending_changes',
    'List all currently pending (user-unreviewed) AI file changes.',
    {
      conversationId: z.string().optional().describe('Filter by conversation ID (optional)'),
    },
    async ({ conversationId }) => {
      let pending = stateManager.getAllPending();
      if (conversationId) {
        pending = pending.filter(c => c.conversationId === conversationId);
      }

      if (pending.length === 0) {
        return {
          content: [{ type: 'text', text: 'No pending AI changes.' }],
        };
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
        content: [
          {
            type: 'text',
            text: `Pending AI changes (${pending.length}):\n\n${lines.join('\n\n')}`,
          },
        ],
      };
    }
  );

  // ─────────────────────────────────────────────────────────
  // Tool: read_rejected_changes
  // ─────────────────────────────────────────────────────────
  server.tool(
    'read_rejected_changes',
    `Read the log of changes that the user rejected.

Use this to understand what the user disliked and avoid making the same mistakes.
Each rejection includes the original content, the rejected AI content, and an optional reason.`,
    {
      limit: z.number().optional().default(10).describe('Max number of rejections to return (default 10)'),
      conversationId: z.string().optional().describe('Filter by conversation ID (optional)'),
    },
    async ({ limit, conversationId }) => {
      let rejected = stateManager.getRejectedChanges(limit ?? 10);
      if (conversationId) {
        rejected = rejected.filter(r => r.conversationId === conversationId);
      }

      if (rejected.length === 0) {
        return {
          content: [{ type: 'text', text: 'No rejected changes found.' }],
        };
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
        content: [
          {
            type: 'text',
            text: `Rejected changes (${rejected.length}):\n\n${lines.join('\n\n')}`,
          },
        ],
      };
    }
  );

  return server;
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

  // Session map — one transport per connected client session
  const transports = new Map<string, StreamableHTTPServerTransport>();

  const httpServer = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);

    // ── Health / discovery ────────────────────────────────────
    if (req.method === 'GET' && url.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', name: 'vscode-diff-mcp', version: '0.1.0' }));
      return;
    }

    // ── Streamable HTTP MCP endpoint (/mcp) ───────────────────
    if (url.pathname === '/mcp') {
      // DELETE — client closing session explicitly
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

      // POST / GET — main MCP communication
      if (req.method === 'POST' || req.method === 'GET') {
        const sessionId = req.headers['mcp-session-id'] as string | undefined;
        let transport: StreamableHTTPServerTransport;

        if (sessionId && transports.has(sessionId)) {
          // Resume existing session
          transport = transports.get(sessionId)!;
        } else if (!sessionId && req.method === 'POST') {
          // New session — create a stateful transport
          transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => crypto.randomUUID(),
            onsessioninitialized: (id) => {
              transports.set(id, transport);
            },
          });

          // Clean up on close
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
