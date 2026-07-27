import type { ContextPackage } from './types.js';

function maxConsecutiveBackticks(content: string): number {
  let max = 0;
  let current = 0;
  for (const char of content) {
    if (char === '`') {
      current++;
      max = Math.max(max, current);
    } else {
      current = 0;
    }
  }
  return max;
}

function wrapInCodeFence(content: string): string {
  const needed = Math.max(3, maxConsecutiveBackticks(content) + 1);
  const fence = '`'.repeat(needed);
  return `${fence}text\n${content}\n${fence}`;
}

export function buildKimiPrompt(context: ContextPackage): string {
  const constraintsSection =
    context.constraints.length > 0
      ? context.constraints.map((c) => `- ${c}`).join('\n')
      : '- No additional constraints';

  const filesSection = context.files
    .map((f) => `## ${f.path}\n\n${wrapInCodeFence(f.content)}`)
    .join('\n\n');

  const lineLimitSection =
    context.max_lines_changed !== undefined
      ? `\n\n# Line change budget\n\n` +
        `HARD UPPER BOUND: no single file may change by more than ${context.max_lines_changed} lines. ` +
        `For a newly created file this means the full file content must be ${context.max_lines_changed} lines or fewer. ` +
        `If the acceptance criteria cannot be met within this budget, return empty files with a note explaining why, ` +
        `rather than producing a change that will be rejected.`
      : '';

  return (
    `# Task\n\n${context.task_summary}\n\n# Goal\n\n${context.goal}\n\n# Constraints\n\n${constraintsSection}${lineLimitSection}\n\n# Files\n\n${filesSection}\n\n# Required output format\n\nReturn ONLY valid JSON.\n\nUse exactly this schema:\n\n\`\`\`json\n{\n  "mode": "file_update",\n  "files": [\n    {\n      "path": "relative/path/from/repo",\n      "content": "full file content after changes"\n    }\n  ],\n  "notes": "short optional note"\n}\n\`\`\`\n\nRules:\n\n* Do not include markdown outside JSON.\n* Do not modify files outside allowed scope.\n* Return full file content, not diffs.\n* Do not invent files unless required by the task.\n* Do not include comments explaining the JSON.\n* files[].content must be the full final file content, not a snippet or demo placeholder.\n* Preserve existing file logic unless the task explicitly requires replacing it.\n* Prefer minimal surgical edits.\n* Do not replace a large existing file with a tiny demo implementation.\n* Do not invent unrelated demo changes.\n* Only modify files required for the task.\n* If the requested change is unclear or context is insufficient, return:\n\n\`\`\`json\n{\n  "mode": "file_update",\n  "files": [],\n  "notes": "Cannot safely modify files because the request is unclear or context is insufficient."\n}\n\`\`\`\n`
  );
}
