import * as vscode from 'vscode';

export interface DiagnosticInfo {
  line: number;
  column: number;
  severity: 'error' | 'warning' | 'info' | 'hint';
  message: string;
  source?: string;
  code?: string;
}

export async function collectDiagnostics(filePath: string, waitMs: number = 500): Promise<{ errors: DiagnosticInfo[], warnings: DiagnosticInfo[] }> {
  const uri = vscode.Uri.file(filePath);
  
  // Wait shortly to let language servers process the file
  await new Promise(resolve => setTimeout(resolve, waitMs));

  const diagnostics = vscode.languages.getDiagnostics(uri);
  
  const errors: DiagnosticInfo[] = [];
  const warnings: DiagnosticInfo[] = [];

  for (const diag of diagnostics) {
    const info: DiagnosticInfo = {
      line: diag.range.start.line + 1, // 0-indexed to 1-indexed
      column: diag.range.start.character + 1,
      severity: getSeverityString(diag.severity),
      message: diag.message,
      source: diag.source,
      code: typeof diag.code === 'object' ? String(diag.code.value) : String(diag.code || '')
    };

    if (diag.severity === vscode.DiagnosticSeverity.Error) {
      errors.push(info);
    } else if (diag.severity === vscode.DiagnosticSeverity.Warning) {
      warnings.push(info);
    }
  }

  return { errors, warnings };
}

function getSeverityString(severity: vscode.DiagnosticSeverity): 'error' | 'warning' | 'info' | 'hint' {
  switch (severity) {
    case vscode.DiagnosticSeverity.Error: return 'error';
    case vscode.DiagnosticSeverity.Warning: return 'warning';
    case vscode.DiagnosticSeverity.Information: return 'info';
    case vscode.DiagnosticSeverity.Hint: return 'hint';
    default: return 'info';
  }
}
