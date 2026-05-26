import { isAbsolute } from 'node:path';
import type { KimiOutput } from './types.js';

function isObject(val: unknown): val is Record<string, unknown> {
  return typeof val === 'object' && val !== null && !Array.isArray(val);
}

function normalizePath(filePath: string): string {
  return filePath.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+/g, '/');
}

function validatePath(path: string, index: number): void {
  if (typeof path !== 'string' || path.length === 0) {
    throw new Error(
      `KimiOutput.files[${index}].path must be a non-empty string`
    );
  }
  if (isAbsolute(path)) {
    throw new Error(`Absolute paths are not allowed: ${path}`);
  }
  if (path.includes(':')) {
    throw new Error(`Colons are not allowed in repo-relative paths: ${path}`);
  }
  if (path.includes('..')) {
    throw new Error(`Path traversal detected: ${path}`);
  }
  if (path.includes('\\')) {
    throw new Error(`Backslash not allowed, use unix paths: ${path}`);
  }
}

export function validateKimiOutput(value: unknown): KimiOutput {
  if (!isObject(value)) {
    throw new Error('KimiOutput must be an object');
  }

  if (value.mode !== 'file_update') {
    throw new Error(
      `Invalid KimiOutput mode: expected "file_update", got "${String(value.mode)}"`
    );
  }

  if (!Array.isArray(value.files)) {
    throw new Error('KimiOutput.files must be an array');
  }

  if (value.files.length === 0) {
    throw new Error('KimiOutput.files must not be empty');
  }

  const seen = new Set<string>();
  const files: { path: string; content: string }[] = [];

  for (let i = 0; i < value.files.length; i++) {
    const item = value.files[i];
    if (!isObject(item)) {
      throw new Error(`KimiOutput.files[${i}] must be an object`);
    }

    const path = item.path;
    validatePath(path as string, i);

    const content = item.content;
    if (typeof content !== 'string') {
      throw new Error(
        `KimiOutput.files[${i}].content must be a string`
      );
    }

    const normalized = normalizePath(path as string);
    if (seen.has(normalized)) {
      throw new Error(`Duplicate file update: ${path}`);
    }
    seen.add(normalized);

    files.push({ path: path as string, content });
  }

  return {
    mode: 'file_update',
    files,
    notes: typeof value.notes === 'string' ? value.notes : undefined,
  };
}

export function parseKimiOutputJson(raw: string): KimiOutput {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Invalid Kimi JSON output: ${message}`);
  }
  return validateKimiOutput(parsed);
}
