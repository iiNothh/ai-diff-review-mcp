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
