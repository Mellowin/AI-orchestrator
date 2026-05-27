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

  return `# Task\n\n${context.task_summary}\n\n# Goal\n\n${context.goal}\n\n# Constraints\n\n${constraintsSection}\n\n# Files\n\n${filesSection}\n\n# Required output format\n\nReturn ONLY valid JSON.\n\nUse exactly this schema:\n\n\`\`\`json\n{\n  "mode": "file_update",\n  "files": [\n    {\n      "path": "relative/path/from/repo",\n      "content": "full file content after changes"\n    }\n  ],\n  "notes": "short optional note"\n}\n\`\`\`\n\nRules:\n\n* Do not include markdown outside JSON.\n* Do not modify files outside allowed scope.\n* Return full file content, not diffs.\n* Do not invent files unless required by the task.\n* Do not include comments explaining the JSON.\n`;
}
