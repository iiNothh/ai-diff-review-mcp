import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { PendingChange, RejectedChange, StateFile, RejectsFile } from './types';

const STATE_DIR = '.vscode/mcp-diff-state';
const PENDING_FILE = 'pending.json';
const REJECTS_FILE = 'rejects.json';
const BACKUPS_DIR = 'backups';
const STATE_VERSION = 1;

export class StateManager {
  private pendingChanges: Map<string, PendingChange> = new Map();
  private stateDir: string;
  private pendingFilePath: string;
  private rejectsFilePath: string;
  private backupsDir: string;
  private _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;

  constructor(workspaceRoot: string) {
    this.stateDir = path.join(workspaceRoot, STATE_DIR);
    this.pendingFilePath = path.join(this.stateDir, PENDING_FILE);
    this.rejectsFilePath = path.join(this.stateDir, REJECTS_FILE);
    this.backupsDir = path.join(this.stateDir, BACKUPS_DIR);
  }

  /** Load persisted state from disk on extension activation */
  async loadState(): Promise<void> {
    try {
      if (!fs.existsSync(this.stateDir)) {
        fs.mkdirSync(this.stateDir, { recursive: true });
      }
      if (!fs.existsSync(this.backupsDir)) {
        fs.mkdirSync(this.backupsDir, { recursive: true });
      }
      if (fs.existsSync(this.pendingFilePath)) {
        const raw = fs.readFileSync(this.pendingFilePath, 'utf-8');
        const data: StateFile = JSON.parse(raw);
        this.pendingChanges.clear();
        for (const change of data.pending) {
          // Only restore if backup still exists
          if (fs.existsSync(change.backupPath)) {
            this.pendingChanges.set(change.id, change);
          }
        }
        this.savePending(); // Clean up orphaned entries
      }
    } catch (err) {
      console.error('[StateManager] Failed to load state:', err);
    }
  }

  /** Generate a UUID */
  private generateId(): string {
    return crypto.randomUUID();
  }

  /** Compute SHA-256 hash of a file's content */
  computeFileHash(filePath: string): string {
    const content = fs.readFileSync(filePath);
    return crypto.createHash('sha256').update(content).digest('hex');
  }

  /** Track any file operation: write, append or edit block */
  async trackFileOperation(
    filePath: string,
    operation: () => Promise<void>,
    editType: 'write_file' | 'edit_block' | 'suggest_edit',
    description?: string,
    conversationId?: string
  ): Promise<PendingChange> {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    let changeId = '';
    let backupPath = '';

    for (const [id, c] of this.pendingChanges.entries()) {
      if (c.filePath === filePath) {
        changeId = id;
        backupPath = c.backupPath;
        break;
      }
    }

    if (!changeId) {
      changeId = this.generateId();
      backupPath = path.join(this.backupsDir, `${changeId}.bak`);

      let originalContent = '';
      if (fs.existsSync(filePath)) {
        originalContent = fs.readFileSync(filePath, 'utf-8');
      }
      fs.writeFileSync(backupPath, originalContent, 'utf-8');
    }

    // Execute the requested file operation
    await operation();

    // Compute hash of new content (for conflict detection)
    const fileHashAfterEdit = this.computeFileHash(filePath);

    const change: PendingChange = {
      id: changeId,
      filePath,
      backupPath,
      timestamp: new Date().toISOString(),
      description,
      conversationId,
      fileHashAfterEdit,
      editType
    };

    this.pendingChanges.set(changeId, change);
    this.savePending();
    this._onDidChange.fire();
    return change;
  }

  /** Backward-compatible wrapper for the old suggest_edit */
  async addPendingChange(
    filePath: string,
    newContent: string,
    description?: string,
    conversationId?: string
  ): Promise<PendingChange> {
    return this.trackFileOperation(
      filePath,
      async () => {
        fs.writeFileSync(filePath, newContent, 'utf-8');
      },
      'suggest_edit',
      description,
      conversationId
    );
  }

  /** Accept a change: remove from pending, delete backup */
  acceptChange(id: string): void {
    const change = this.pendingChanges.get(id);
    if (!change) {
      throw new Error(`No pending change with id: ${id}`);
    }
    // Delete backup file
    if (fs.existsSync(change.backupPath)) {
      fs.unlinkSync(change.backupPath);
    }
    this.pendingChanges.delete(id);
    this.savePending();
    this._onDidChange.fire();
  }

  /**
   * Reject a change: restore original from backup, log rejection, remove from pending.
   * Returns whether a conflict was detected (user edited file after AI).
   */
  async rejectChange(
    id: string,
    reason?: string
  ): Promise<{ conflictDetected: boolean }> {
    const change = this.pendingChanges.get(id);
    if (!change) {
      throw new Error(`No pending change with id: ${id}`);
    }

    // Conflict detection: check if file was modified after AI edit
    let conflictDetected = false;
    if (fs.existsSync(change.filePath)) {
      const currentHash = this.computeFileHash(change.filePath);
      if (currentHash !== change.fileHashAfterEdit) {
        conflictDetected = true;
      }
    }

    // Read the rejected content (what AI wrote) for the log
    let rejectedContent = '';
    if (fs.existsSync(change.filePath)) {
      rejectedContent = fs.readFileSync(change.filePath, 'utf-8');
    }

    // Read backup (original content)
    let originalContent = '';
    if (fs.existsSync(change.backupPath)) {
      originalContent = fs.readFileSync(change.backupPath, 'utf-8');
    }

    // Restore original from backup
    fs.writeFileSync(change.filePath, originalContent, 'utf-8');

    // Log rejection
    this.appendRejection({
      id: change.id,
      filePath: change.filePath,
      timestamp: new Date().toISOString(),
      reason,
      originalContent,
      rejectedContent,
      description: change.description,
      conversationId: change.conversationId,
    });

    // Cleanup backup
    if (fs.existsSync(change.backupPath)) {
      fs.unlinkSync(change.backupPath);
    }

    this.pendingChanges.delete(id);
    this.savePending();
    this._onDidChange.fire();
    return { conflictDetected };
  }

  /** Get all pending changes as an array */
  getAllPending(): PendingChange[] {
    return Array.from(this.pendingChanges.values()).sort(
      (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
    );
  }

  /** Get a single pending change by ID */
  getPendingById(id: string): PendingChange | undefined {
    return this.pendingChanges.get(id);
  }

  /** Get recent rejected changes */
  getRejectedChanges(limit = 10): RejectedChange[] {
    try {
      if (!fs.existsSync(this.rejectsFilePath)) return [];
      const raw = fs.readFileSync(this.rejectsFilePath, 'utf-8');
      const data: RejectsFile = JSON.parse(raw);
      return data.rejected
        .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
        .slice(0, limit);
    } catch {
      return [];
    }
  }

  /** Get backup file path for a pending change */
  getBackupUri(id: string): vscode.Uri | undefined {
    const change = this.pendingChanges.get(id);
    if (!change || !fs.existsSync(change.backupPath)) return undefined;
    return vscode.Uri.file(change.backupPath);
  }

  private savePending(): void {
    try {
      const data: StateFile = {
        version: STATE_VERSION,
        pending: Array.from(this.pendingChanges.values()),
      };
      fs.writeFileSync(this.pendingFilePath, JSON.stringify(data, null, 2), 'utf-8');
    } catch (err) {
      console.error('[StateManager] Failed to save pending state:', err);
    }
  }

  private appendRejection(rejection: RejectedChange): void {
    try {
      let data: RejectsFile = { version: STATE_VERSION, rejected: [] };
      if (fs.existsSync(this.rejectsFilePath)) {
        const raw = fs.readFileSync(this.rejectsFilePath, 'utf-8');
        data = JSON.parse(raw);
      }
      data.rejected.unshift(rejection); // newest first
      // Keep max 200 rejections
      if (data.rejected.length > 200) {
        data.rejected = data.rejected.slice(0, 200);
      }
      fs.writeFileSync(this.rejectsFilePath, JSON.stringify(data, null, 2), 'utf-8');
    } catch (err) {
      console.error('[StateManager] Failed to append rejection:', err);
    }
  }

  dispose(): void {
    this._onDidChange.dispose();
  }
}
