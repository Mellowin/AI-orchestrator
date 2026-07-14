import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { ReliabilityScenarioConfig } from './types.js';

export function loadReliabilityScenario(path: string): ReliabilityScenarioConfig {
  if (!existsSync(path)) {
    throw new Error(`Scenario file not found: ${path}`);
  }
  const raw = readFileSync(path, 'utf-8');
  const parsed = JSON.parse(raw) as unknown;
  return validateReliabilityScenario(parsed, path);
}

export function loadReliabilityScenarios(dir: string): ReliabilityScenarioConfig[] {
  if (!existsSync(dir)) {
    return [];
  }
  const entries = readdirSync(dir, { withFileTypes: true });
  const ignored = new Set(['config.json', 'README.json', 'package.json', 'tsconfig.json']);
  const files = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json') && !ignored.has(entry.name))
    .map((entry) => join(dir, entry.name))
    .sort();
  return files.map((file) => loadReliabilityScenario(file));
}

function validateReliabilityScenario(parsed: unknown, path: string): ReliabilityScenarioConfig {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Invalid scenario JSON (expected object): ${path}`);
  }
  const obj = parsed as Record<string, unknown>;

  function requiredString(key: string): string {
    const value = obj[key];
    if (typeof value !== 'string' || value.length === 0) {
      throw new Error(`Scenario ${path} missing required field: ${key}`);
    }
    return value;
  }

  function requiredStringArray(key: string): string[] {
    const value = obj[key];
    if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
      throw new Error(`Scenario ${path} field ${key} must be an array of strings`);
    }
    return value;
  }

  const id = requiredString('id');
  const category = requiredString('category');
  if (category !== 'fixable' && category !== 'external' && category !== 'unsafe') {
    throw new Error(`Scenario ${path} invalid category: ${category}`);
  }
  const classification = requiredString('classification');
  const fixable = obj.fixable === true;
  const allowedFiles = requiredStringArray('allowed_files');
  const trustedMaintenanceFiles = Array.isArray(obj.trusted_maintenance_files)
    ? obj.trusted_maintenance_files.filter((item): item is string => typeof item === 'string')
    : undefined;
  const deniedFiles = Array.isArray(obj.denied_files)
    ? obj.denied_files.filter((item): item is string => typeof item === 'string')
    : undefined;
  const repairStrategy = typeof obj.repair_strategy === 'string' ? obj.repair_strategy : undefined;
  const note = typeof obj.note === 'string' ? obj.note : undefined;
  const expectedVerdict = requiredString('expected_verdict');

  const setup = validatePatches(obj.setup, path, 'setup');
  const fix = validatePatches(obj.fix, path, 'fix', true);
  const verificationCommands = validateCommandArray(obj.verification_commands, path, 'verification_commands', true);
  const reproductionCommand = validateCommand(obj.reproduction_command, path, 'reproduction_command', true);

  return {
    id,
    category,
    classification: classification as ReliabilityScenarioConfig['classification'],
    fixable,
    repair_strategy: repairStrategy,
    allowed_files: allowedFiles,
    trusted_maintenance_files: trustedMaintenanceFiles,
    denied_files: deniedFiles,
    setup,
    fix,
    verification_commands: verificationCommands,
    reproduction_command: reproductionCommand,
    expected_verdict: expectedVerdict as ReliabilityScenarioConfig['expected_verdict'],
    note,
  };
}

function validateCommand(
  value: unknown,
  path: string,
  field: string,
  optional: boolean
): string[] | undefined {
  if (value === undefined) {
    if (!optional) throw new Error(`Scenario ${path} missing ${field}`);
    return undefined;
  }
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error(`Scenario ${path} field ${field} must be an array of strings`);
  }
  return value as string[];
}

function validateCommandArray(
  value: unknown,
  path: string,
  field: string,
  optional: boolean
): string[][] | undefined {
  if (value === undefined) {
    if (!optional) throw new Error(`Scenario ${path} missing ${field}`);
    return undefined;
  }
  if (!Array.isArray(value) || value.some((item) => !Array.isArray(item) || item.some((s) => typeof s !== 'string'))) {
    throw new Error(`Scenario ${path} field ${field} must be an array of string arrays`);
  }
  return value as string[][];
}

function validatePatches(
  value: unknown,
  path: string,
  field: string,
  optional = false
): ReliabilityScenarioConfig['setup'] {
  if (value === undefined) {
    if (!optional) throw new Error(`Scenario ${path} missing ${field}`);
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error(`Scenario ${path} field ${field} must be an array`);
  }
  return value.map((item, index) => {
    if (typeof item !== 'object' || item === null) {
      throw new Error(`Scenario ${path} ${field}[${index}] must be an object`);
    }
    const patch = item as Record<string, unknown>;
    const patchPath = typeof patch.path === 'string' ? patch.path : '';
    const replace = typeof patch.replace === 'string' ? patch.replace : '';
    const search = typeof patch.search === 'string' ? patch.search : undefined;
    const overwrite = patch.overwrite === true;
    if (!patchPath) {
      throw new Error(`Scenario ${path} ${field}[${index}] missing path`);
    }
    if (!overwrite && search === undefined) {
      throw new Error(`Scenario ${path} ${field}[${index}] requires search or overwrite`);
    }
    return { path: patchPath, replace, search, overwrite };
  });
}
