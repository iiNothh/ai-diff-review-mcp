// Shared types for the VS Code Diff MCP Extension

export interface PendingChange {
  /** Unique identifier (UUID) */
  id: string;
  /** Absolute path to the edited file */
  filePath: string;
  /** Absolute path to the backup file (.vscode/mcp-diff-state/backups/<id>.bak) */
  backupPath: string;
  /** ISO 8601 timestamp of when the edit was proposed */
  timestamp: string;
  /** AI's description of what was changed */
  description?: string;
  /** Conversation ID from the AI agent */
  conversationId?: string;
  /** SHA-256 hash of the file AFTER the AI wrote the new content (for conflict detection) */
  fileHashAfterEdit: string;
  /** The type of edit performed */
  editType: 'write_file' | 'edit_block' | 'suggest_edit';
}

export interface RejectedChange {
  /** Unique identifier, matches original PendingChange.id */
  id: string;
  /** Absolute path to the file that was edited */
  filePath: string;
  /** ISO 8601 timestamp of rejection */
  timestamp: string;
  /** User's optional reason for rejection */
  reason?: string;
  /** Content of the file BEFORE the AI edit (what was restored) */
  originalContent: string;
  /** Content of the file AFTER the AI edit (what was rejected) */
  rejectedContent: string;
  /** AI's original description */
  description?: string;
  /** Conversation ID from the AI agent */
  conversationId?: string;
}

export interface StateFile {
  pending: PendingChange[];
  version: number;
}

export interface RejectsFile {
  rejected: RejectedChange[];
  version: number;
}
