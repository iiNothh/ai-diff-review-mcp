import * as fs from 'fs';
import * as fsPromises from 'fs/promises';
import * as path from 'path';
import { distance } from 'fastest-levenshtein';

export type LineEndingStyle = '\r\n' | '\n' | '\r';

export function detectLineEnding(content: string): LineEndingStyle {
    for (let i = 0; i < content.length; i++) {
        if (content[i] === '\r') {
            if (i + 1 < content.length && content[i + 1] === '\n') {
                return '\r\n';
            }
            return '\r';
        }
        if (content[i] === '\n') {
            return '\n';
        }
    }
    return process.platform === 'win32' ? '\r\n' : '\n';
}

export function normalizeLineEndings(text: string, targetLineEnding: LineEndingStyle): string {
    let normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    if (targetLineEnding === '\r\n') {
        return normalized.replace(/\n/g, '\r\n');
    } else if (targetLineEnding === '\r') {
        return normalized.replace(/\n/g, '\r');
    }
    return normalized;
}

export function recursiveFuzzyIndexOf(text: string, query: string, start: number = 0, end: number | null = null, parentDistance: number = Infinity): { start: number; end: number; value: string; distance: number; } {
    if (end === null) end = text.length;
    if (end - start <= 2 * query.length) return iterativeReduction(text, query, start, end, parentDistance);

    let midPoint = start + Math.floor((end - start) / 2);
    let leftEnd = Math.min(end, midPoint + query.length);
    let rightStart = Math.max(start, midPoint - query.length);

    let leftDistance = distance(text.substring(start, leftEnd), query);
    let rightDistance = distance(text.substring(rightStart, end), query);
    let bestDistance = Math.min(leftDistance, parentDistance, rightDistance);

    if (parentDistance === bestDistance) return iterativeReduction(text, query, start, end, parentDistance);

    if (leftDistance < rightDistance) {
        return recursiveFuzzyIndexOf(text, query, start, leftEnd, bestDistance);
    } else {
        return recursiveFuzzyIndexOf(text, query, rightStart, end, bestDistance);
    }
}

function iterativeReduction(text: string, query: string, start: number, end: number, parentDistance: number): { start: number; end: number; value: string; distance: number; } {
    let bestDistance = parentDistance;
    let bestStart = start;
    let bestEnd = end;

    let nextDistance = distance(text.substring(bestStart + 1, bestEnd), query);
    while (nextDistance < bestDistance) {
        bestDistance = nextDistance;
        bestStart++;
        nextDistance = distance(text.substring(bestStart + 1, bestEnd), query);
    }

    nextDistance = distance(text.substring(bestStart, bestEnd - 1), query);
    while (nextDistance < bestDistance) {
        bestDistance = nextDistance;
        bestEnd--;
        nextDistance = distance(text.substring(bestStart, bestEnd - 1), query);
    }

    return { start: bestStart, end: bestEnd, value: text.substring(bestStart, bestEnd), distance: bestDistance };
}

export function getSimilarityRatio(a: string, b: string): number {
    const maxLength = Math.max(a.length, b.length);
    if (maxLength === 0) return 1;
    return 1 - (distance(a, b) / maxLength);
}

export async function writeFileContent(filePath: string, content: string, mode: 'rewrite' | 'append' = 'rewrite'): Promise<void> {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
        await fsPromises.mkdir(dir, { recursive: true });
    }
    if (mode === 'append') {
        const existingLineEnding = fs.existsSync(filePath) ? detectLineEnding(await fsPromises.readFile(filePath, 'utf-8')) : (process.platform === 'win32' ? '\r\n' : '\n');
        const contentToWrite = normalizeLineEndings(content, existingLineEnding);
        await fsPromises.appendFile(filePath, contentToWrite, 'utf-8');
    } else {
        await fsPromises.writeFile(filePath, content, 'utf-8');
    }
}

export async function performSearchReplace(filePath: string, oldString: string, newString: string, expectedReplacements: number = 1): Promise<{ success: true, newContent: string } | { success: false, message: string }> {
    if (!fs.existsSync(filePath)) {
        return { success: false, message: `File does not exist: ${filePath}` };
    }
    const content = await fsPromises.readFile(filePath, 'utf-8');
    const existingLineEnding = detectLineEnding(content);

    const normalizedOld = normalizeLineEndings(oldString, existingLineEnding);
    const normalizedNew = normalizeLineEndings(newString, existingLineEnding);

    const parts = content.split(normalizedOld);
    const count = parts.length - 1;

    if (count === expectedReplacements) {
        const modified = parts.join(normalizedNew);
        await fsPromises.writeFile(filePath, modified, 'utf-8');
        return { success: true, newContent: modified };
    }

    if (count > 0 && count !== expectedReplacements) {
        return { success: false, message: `Found ${count} occurrences of the search string but expected ${expectedReplacements}. Make your search string more specific.` };
    }

    // Fuzzy matching fallback
    const lfContent = normalizeLineEndings(content, '\n');
    const lfQuery = normalizeLineEndings(oldString, '\n');

    const fuzzyResult = recursiveFuzzyIndexOf(lfContent, lfQuery);
    const similarity = getSimilarityRatio(fuzzyResult.value, lfQuery);

    if (similarity > 0.7) {
        return {
            success: false,
            message: `Exact match not found. Found a close match (similarity: ${(similarity * 100).toFixed(1)}%).\n\nExpected:\n${lfQuery}\n\nFound:\n${fuzzyResult.value}\n\nPlease update your old_string to match the 'Found' text exactly.`
        };
    }

    return {
        success: false,
        message: `Could not find the requested text block to replace. No close matches found (best match similarity: ${(similarity * 100).toFixed(1)}%). Check your old_string.`
    };
}

export interface EditOperation {
    oldString: string;
    newString: string;
    startLine: number;
}

export type EditOperationResult =
    | { success: true }
    | { success: false; editIndex: number; message: string; actualContent: string };

/**
 * Apply multiple line-anchored edits to a file in a single pass.
 *
 * For each edit:
 *   - startLine (1-indexed) is where oldString is expected to begin.
 *   - The engine reads exactly as many characters as oldString from that line offset
 *     and checks for an exact match — no full-file scan, no ambiguity.
 *   - If the content at startLine differs (user edited it), the actual content
 *     of that region is returned so the caller can self-correct.
 *
 * Edits are applied top-to-bottom on the in-memory content so line numbers
 * remain stable relative to the original file. The file is written once at the end.
 */
export async function performBatchLineAnchoredReplace(
    filePath: string,
    edits: EditOperation[]
): Promise<{ success: true; newContent: string } | { success: false; results: EditOperationResult[] }> {
    if (!fs.existsSync(filePath)) {
        return {
            success: false,
            results: [{ success: false, editIndex: 0, message: `File does not exist: ${filePath}`, actualContent: '' }],
        };
    }

    const raw = await fsPromises.readFile(filePath, 'utf-8');
    const existingLineEnding = detectLineEnding(raw);
    const sep = existingLineEnding === '\r\n' ? '\r\n' : existingLineEnding === '\r' ? '\r' : '\n';

    // Work on LF-normalised lines internally; re-join with original sep at end
    let lines = raw.split(/\r?\n|\r/);
    const totalLines = lines.length;

    // Sort edits by startLine ascending so offsets stay valid as we apply them
    const sortedEdits = edits
        .map((e, i) => ({ ...e, originalIndex: i }))
        .sort((a, b) => a.startLine - b.startLine);

    const failures: EditOperationResult[] = [];
    let lineOffset = 0; // cumulative shift from previous edits that changed line count

    for (const edit of sortedEdits) {
        const { oldString, newString, startLine, originalIndex } = edit;
        const adjustedStart = startLine - 1 + lineOffset; // 0-indexed

        if (adjustedStart < 0 || adjustedStart >= lines.length) {
            failures.push({
                success: false,
                editIndex: originalIndex,
                message: `startLine ${startLine} is out of range (file has ${totalLines} lines).`,
                actualContent: '',
            });
            continue;
        }

        // Build the normalized oldString and figure out how many lines it spans
        const normalizedOld = normalizeLineEndings(oldString, sep as LineEndingStyle);
        const oldLines = normalizedOld.split(/\r?\n|\r/);
        const spanEnd = adjustedStart + oldLines.length; // exclusive

        // Extract that exact region from the current (already-partially-edited) lines array
        const regionLines = lines.slice(adjustedStart, spanEnd);
        const regionText = regionLines.join(sep);

        if (regionText !== normalizedOld) {
            // Content at startLine doesn't match — return what's actually there
            failures.push({
                success: false,
                editIndex: originalIndex,
                message:
                    `oldString does not match the file content at line ${startLine}.\n\n` +
                    `Expected:\n${oldString}\n\nActual content at line ${startLine}:\n${regionText}\n\n` +
                    `Please correct oldString to match the actual content exactly.`,
                actualContent: regionText,
            });
            continue;
        }

        // Replace the region
        const normalizedNew = normalizeLineEndings(newString, sep as LineEndingStyle);
        const newLines = normalizedNew.split(/\r?\n|\r/);
        lines = [...lines.slice(0, adjustedStart), ...newLines, ...lines.slice(spanEnd)];
        lineOffset += newLines.length - oldLines.length;
    }

    if (failures.length > 0) {
        return { success: false, results: failures };
    }

    const newContent = lines.join(sep);
    await fsPromises.writeFile(filePath, newContent, 'utf-8');
    return { success: true, newContent };
}

/**
 * Search for a pattern (literal string or regex) across file content.
 * Returns all matches with line numbers.
 */
export async function searchInFile(
    filePath: string,
    pattern: string,
    isRegex: boolean
): Promise<Array<{ line: number; column: number; text: string }>> {
    if (!fs.existsSync(filePath)) return [];
    const content = await fsPromises.readFile(filePath, 'utf-8');
    const lines = content.split(/\r?\n|\r/);
    const results: Array<{ line: number; column: number; text: string }> = [];

    for (let i = 0; i < lines.length; i++) {
        const lineText = lines[i];
        if (isRegex) {
            try {
                const re = new RegExp(pattern, 'g');
                let m: RegExpExecArray | null;
                while ((m = re.exec(lineText)) !== null) {
                    results.push({ line: i + 1, column: m.index + 1, text: lineText });
                    if (!re.global) break;
                }
            } catch {
                // invalid regex — bubble up as empty
            }
        } else {
            let idx = lineText.indexOf(pattern);
            while (idx !== -1) {
                results.push({ line: i + 1, column: idx + 1, text: lineText });
                idx = lineText.indexOf(pattern, idx + 1);
            }
        }
    }

    return results;
}
