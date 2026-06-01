# AI Orchestrator — Архитектура MVP

## 1. Общая концепция

Автономный Node.js CLI-инструмент, который берёт задачу из `tasks.yaml`, выполняет её через Kimi API, проверяет результат через OpenAI API (structured reviewer), прогоняет lint/build/test и сохраняет всё состояние в `runs/`.

**Главное правило:** оркестратор никогда не делает `git push`, `merge` и не трогает `main` напрямую.

**Human-in-the-loop:** человек смотрит только финальный отчёт (`summary.md`) или остановку при ошибках. Промежуточные итерации (`needs_changes`) гоняются автоматически между Reviewer и Coder без участия человека.

---

## 1.5. Development Workflow: blocks → small tasks → automated loop

AI Orchestrator строится как полностью автоматизированный pipeline. Текущий процесс разработки самого проекта следует той же логике: **большие блоки дробятся на маленькие безопасные задачи, каждая из которых проходит проверку перед переходом к следующей**.

### Как работает внешний процесс сейчас

```text
Пользователь даёт крупный блок работы
        ↓
Assistant декомпозирует блок на маленькие безопасные задачи
        ↓
Kimi (Coder) реализует одну маленькую задачу
        ↓
Assistant проверяет точный commit (diff, тесты, поведение)
        ↓
Если commit принят → следующая маленькая задача
Если есть проблемы → маленький fix-task
        ↓
Каждый шаг: typecheck + build + test + CI
        ↓
Пользователь смотрит итог блока (CI, визуал, поведение)
        ↓
Принять блок или дать фикс
```

**Пользователь не участвует в каждой микродетали.** Он участвует на уровне блоков: даёт направление, проверяет финальный результат, решает — двигаться дальше или откатить.

### Как это перейдёт во внутреннюю автоматизацию

Когда AI Orchestrator будет готов, тот же цикл замкнётся внутри CLI:

```text
TaskLoader → StateManager → GitManager
        ↓
ContextBuilder → Kimi Coder
        ↓
PatchEngine → Guardrails → Runner
        ↓
OpenAI Reviewer
        ↓
verdict === 'approve'     → commit + summary.md → STOP
verdict === 'needs_changes' → feedback → next iteration
verdict === 'reject'        → rollback → STOP (human review)
max attempts reached        → failed_max_attempts → STOP
```

Внешний процесс (Assistant + Kimi) — это **прототип внутреннего цикла**, который позже заменит `npx tsx src/cli.ts run <taskId>`.

### Принципы декомпозиции

1. **Один commit = одна маленькая задача.** Не смешивать фичу, рефакторинг и тесты в одном коммите, если это разные задачи.
2. **Безопасность прежде всего.** Каждая задача должна оставить проект в рабочем состоянии: typecheck проходит, тесты проходят.
3. **Тесты обязательны.** Каждое изменение runtime-кода должно сопровождаться тестами или обновлением существующих.
4. **Не прыгать вперёд.** Не реализовывать следующий блок, пока текущий не стабилен.
5. **CI — стоп-кран.** Если CI красный, следующая задача не начинается, пока CI не станет зелёным.

---

## 2. Технологический стек

| Компонент | Выбор |
|-----------|-------|
| Runtime | Node.js 20+ |
| Language | TypeScript (ES Modules) |
| HTTP-клиент | `openai` SDK (совместимый с Kimi через `baseURL`) |
| YAML-парсер | `yaml` |
| ENV | `dotenv` |
| Git | Git CLI через `child_process` |
| Сборка | `tsc` или `tsx` для dev |

Без фреймворков, без БД, без веб-интерфейса.

---

## 3. Структура проекта

```
ai-orchestrator/
├── package.json
├── tsconfig.json
├── .env.example
├── .gitignore
├── ARCHITECTURE.md          # этот документ
├── AGENTS.md                # инструкции для AI-агентов
├── tasks.yaml               # список задач
├── prompts/
│   ├── coder.md             # системный промпт + user template для Kimi
│   └── reviewer.md          # системный промпт + user template для OpenAI
├── src/
│   ├── types.ts             # единый источник TypeScript-интерфейсов
│   ├── config.ts            # ENV + defaults + validation
│   ├── cli.ts               # CLI entry point (orchestrator)
│   ├── task-loader.ts       # Чтение и валидация tasks.yaml
│   ├── state-manager.ts     # Persistence state.json + runs/
│   ├── git-manager.ts       # Branch, diff, commit, ensure clean
│   ├── guardrails.ts        # Проверка allow/deny/max_lines/tests
│   ├── context-builder.ts   # Сборка контекста для LLM
│   ├── ai-client.ts         # Kimi Coder + OpenAI Reviewer + mock mode
│   ├── patch-engine.ts      # Применение file_updates + backup/restore
│   ├── runner.ts            # npm run lint/build/test
│   └── reporter.ts          # Формирование summary для человека
└── runs/                    # gitignored, runtime state
```

---

## 4. Модули: интерфейсы и ответственность

### 4.1. `src/types.ts`

Единый файл со всеми интерфейсами проекта.

```typescript
export interface Task {
  id: string;
  title: string;
  repo_path: string;        // абсолютный или относительный путь к целевому репо
  base_branch: string;      // откуда создаём ветку (default: 'main')
  work_branch: string;      // имя ветки, которую создаст оркестратор
  goal: string;             // описание задачи
  context_files: string[];  // относительные пути внутри repo_path
  checks: Check[];          // команды для запуска
  guardrails: Guardrails;
}

export interface Check {
  command: string;          // например "npm"
  args: string[];           // например ["run", "lint"]
}

export interface Guardrails {
  allow_modify?: string[];  // glob-паттерны. Если указаны — всё остальное запрещено
  deny_modify: string[];    // glob-паттерны, приоритет выше allow
  max_lines_changed?: number;
  require_tests?: boolean;
  auto_commit: boolean;     // default: false
  auto_push: boolean;       // default: false, всегда false для MVP
  auto_merge: boolean;      // default: false, всегда false
}

export interface RunState {
  task_id: string;
  status: RunStatus;
  current_attempt: number;
  branch: string;
  repo_path: string;
  last_kimi_output?: KimiOutput;
  last_review?: ReviewVerdict;
  last_logs?: string;
  created_at: string;
  updated_at: string;
}

export type RunStatus =
  | 'pending'
  | 'coding'
  | 'patching'
  | 'running_checks'
  | 'reviewing'
  | 'approved'
  | 'rejected'
  | 'failed_guardrails'
  | 'failed_max_attempts';

export interface KimiOutput {
  mode: 'file_update';
  files: FileUpdate[];
  notes?: string;
}

export interface FileUpdate {
  path: string;
  content: string;          // всегда полное содержимое файла
}

export interface ReviewVerdict {
  verdict: 'approve' | 'needs_changes' | 'reject';
  critical_issues: string[];
  requested_changes: string[];
  summary_for_human: string;
}

export interface ContextPackage {
  task_summary: string;
  goal: string;
  constraints: string[];
  files: { path: string; content: string }[];
}

export interface ValidationResult {
  ok: boolean;
  reason?: string;
}

export interface RunResult {
  success: boolean;
  logs: string;
  failedStep?: Check;
}

export interface DiffStat {
  files: string[];
  insertions: number;
  deletions: number;
  binaryFiles: string[];    // файлы, которые git считает binary
}

export interface PatchManifestEntry {
  path: string;
  existedBefore: boolean;
  backupPath: string;
}
```

### 4.2. `src/config.ts`

```typescript
export const config = {
  openaiApiKey: process.env.OPENAI_API_KEY,
  kimiApiKey: process.env.KIMI_API_KEY,
  kimiBaseURL: process.env.KIMI_BASE_URL || 'https://api.moonshot.cn/v1',
  kimiModel: process.env.KIMI_MODEL || 'kimi-k2.6',
  openaiReviewModel: process.env.OPENAI_REVIEW_MODEL || 'gpt-4o',
  maxAttempts: Number(process.env.MAX_ATTEMPTS || '3'),
  runsDir: process.env.RUNS_DIR || './runs',
  mockAI: process.env.MOCK_AI === 'true' || false,
};
```

Валидация при старте: если `mockAI === false`, проверить наличие `kimiApiKey` и `openaiApiKey`.

### 4.3. `src/task-loader.ts`

**Вход:** путь к `tasks.yaml`, `taskId`.  
**Выход:** объект `Task` или ошибка.

**Валидация:**
- `deny_modify` default: `['.env', '.env.*', 'node_modules/**', '.git/**']`
- `repo_path` существует и является git-репозиторием (проверка `.git`)
- `base_branch` default: `'main'`
- `context_files` существуют в `repo_path`
- `checks` валидируются как массив объектов `{ command, args }`

### 4.4. `src/state-manager.ts`

**Ответственность:** атомарное сохранение и чтение состояния.

**Файловая структура:**

```
runs/
└── {task_id}/
    ├── state.json
    ├── summary.md
    ├── attempt-1/
    │   ├── kimi-output.json
    │   ├── patch-manifest.json  # backup-метаданные
    │   ├── files-before/        # backup затронутых файлов
    │   ├── build.log
    │   └── review.json
    ├── attempt-2/
    │   └── ...
```

**Методы:**
- `load(taskId): RunState | null` — читает `state.json`, если нет — возвращает `null`.
- `save(taskId, state): void` — атомарно перезаписывает `state.json`.
- `initAttempt(taskId, attemptNum): string` — создаёт папку `attempt-N`, возвращает путь.
- `writeAttemptFile(taskId, attemptNum, filename, data): void`.

**Восстановление:** при повторном запуске `cli.ts run {taskId}` скрипт читает `state.json` и возобновляет с текущего `status` и `current_attempt`.

### 4.5. `src/git-manager.ts`

**Методы:**
- `ensureClean(repoPath): void` — проверяет `git status --porcelain`. Если не чисто — бросает ошибку. **Никаких автоматических `git clean` или `git restore`.**
- `checkoutBranch(repoPath, baseBranch, newBranch): void` — `git checkout -b {newBranch} origin/{baseBranch}` или из локальной `baseBranch`.
- `checkoutExistingBranch(repoPath, branch): void` — `git checkout {branch}`. Используется при `resume`.
- `branchExists(repoPath, branch): boolean` — `git branch --list {branch}`.
- `getCurrentDiff(repoPath): string` — `git diff HEAD`.
- `getDiffNumstat(repoPath): DiffStat` — `git diff --numstat`. Парсит вывод для подсчёта insertions/deletions. **Binary файлы отклоняются guardrails.**
- `commit(repoPath, message): void` — `git add -A && git commit -m "..."`. Вызывается **только** если `guardrails.auto_commit === true`.
- `listChangedFiles(repoPath): string[]` — `git diff --name-only`.

**Правила:**
- Перед стартом — `ensureClean`. Если грязно — STOP.
- **Resume logic:**
  - Новый запуск (`state === null`): `branchExists(work_branch)` → если существует, STOP и спросить человека; иначе `checkoutBranch(base_branch, work_branch)`.
  - Resume (`state !== null`): `checkoutExistingBranch(work_branch)`.
- Никакого `git push`.
- Commit — только при `auto_commit: true`.

### 4.6. `src/guardrails.ts`

**Методы:**
- `validateFileList(files, guardrails): ValidationResult` — deny priority, allow default-deny.
- `validateDiffSize(diffStat, maxLines): ValidationResult` — считает insertions + deletions > maxLines. **Если есть binaryFiles → reject.**
- `validateTestsPresent(changedFiles, requireTests): ValidationResult`.

**Поведение:** любой fail → attempt помечается `failed_guardrails`, причина пишется в state, оркестратор останавливается.

### 4.7. `src/context-builder.ts`

**Метод:** `build(task: Task): ContextPackage`

Логика:
- Читает все `task.context_files` из `repo_path`.
- Дополнительно подтягивает `package.json` целевого проекта (для понимания стека).
- **Перечитывает файлы перед каждой новой попыткой** — если предыдущая попытка изменила файлы, но build упал, Kimi получит актуальные версии.

### 4.8. `src/ai-client.ts`

Два клиента + mock-режим.

**Kimi Coder:**

```typescript
async function askKimi(
  context: ContextPackage,
  previousDiff: string,
  previousLogs: string,
  reviewerFeedback: ReviewVerdict | null
): Promise<KimiOutput>
```

- `openai` SDK с `baseURL: config.kimiBaseURL`, `apiKey: config.kimiApiKey`.
- model: `config.kimiModel`.
- Temperature: `0.1`.
- System prompt: `prompts/coder.md`.
- Парсинг ответа: извлечь JSON из markdown-блока, `JSON.parse()`, валидировать по `KimiOutput`.
- При `config.mockAI === true` — использовать `mockKimi()` из `src/mocks/mock-kimi.ts`.

**OpenAI Reviewer (Structured Output):**

```typescript
async function askReviewer(
  task: Task,
  diff: string,
  changedFiles: string[],
  logs: string
): Promise<ReviewVerdict>
```

- Chat Completions с `response_format: { type: 'json_schema', schema: ... }`.
- model: `config.openaiReviewModel`.
- Temperature: `0`.
- System prompt: `prompts/reviewer.md`.
- При `config.mockAI === true` — использовать `mockReviewer()` из `src/mocks/mock-reviewer.ts`.

### 4.9. `src/patch-engine.ts`

**Метод:** `applyFileUpdates(repoPath, kimiOutput, guardrails): { ok: boolean; changedFiles: string[]; reason?: string }`

**Логика:**
1. Для каждого файла в `kimiOutput.files`:
   - **Path traversal защита:**
     - Запретить absolute paths (`path.isAbsolute`).
     - Запретить `..`.
     - Проверить `path.resolve(repoPath, file.path)`, что итоговый путь начинается с `repoPath` (с учётом Windows paths).
   - Проверить guardrails (`validateFileList`).
   - Сделать backup в `attempt-N/files-before/{relative_path}`.
   - Записать в `patch-manifest.json`: `{ path, existedBefore: boolean, backupPath }`.
   - Перезаписать файл (создать директории через `mkdir -p`).
2. Если хоть один файл не прошёл guardrails или path traversal:
   - Вызвать `rollback(repoPath, manifest)`.
   - Вернуть `{ ok: false, reason }`.
3. Если всё ок — вернуть `{ ok: true, changedFiles }`.

**Rollback:**
- Читает `patch-manifest.json`.
- Для каждой записи:
  - Если `existedBefore === true` — копировать из `backupPath` обратно.
  - Если `existedBefore === false` — удалить созданный файл.

**Безопасность:** никаких `git apply`, `rm -rf`, `exec` с пользовательскими путями. Только перезапись файлов.

### 4.10. `src/runner.ts`

**Метод:** `runChecks(repoPath, checks): RunResult`

- Последовательный запуск через `spawnSync` / `execFileSync` с массивом аргументов.
- Команды берутся из `Check.command` + `Check.args`, не из строки.
- Если команда падает — стоп, возвращаем логи всех выполненных шагов + `failedStep`.
- Логи сохраняются в `attempt-N/build.log`.

### 4.11. `src/reporter.ts`

**Методы:**
- `generateSummary(task, state, attempts): string` — markdown для `runs/{id}/summary.md`.
- `printCliReport(state): void` — цветной вывод в консоль (task ID, attempt, changed files, checks, verdict).

**Формат `summary.md`:**

```markdown
# AI Orchestrator Report: {task_id}

## Task
{title}: {goal}

## Attempt 1
- Status: {status}
- Critical issues: ...
- Requested changes: ...

## Final Diff
```diff
...
```

## How to proceed

```bash
cd {repo_path}
git diff
# Review and then:
git push origin {work_branch}
gh pr create --title "AI: {title}" --body "..."
```
```

---

## 5. Data Flow

```text
START: npx tsx src/cli.ts run {taskId} [--mock]
│
▼ [Config] → валидация ENV (или mock mode)
│
▼ [TaskLoader] → читает tasks.yaml, находит Task
│
▼ [StateManager] → load state.json
│   exists + approved/failed_guardrails/rejected → EXIT
│   exists + другой статус → resume с текущего этапа
│   нет → init new state
│         [GitManager] → new: checkout -b work_branch from base_branch
│                     → resume: checkout existing work_branch
│
▼ LOOP (maxAttempts):
│   ├─→ [ContextBuilder] → перечитывает context_files (актуальные версии)
│   │
│   ├─→ [Kimi Coder] → context + feedback
│   │       ├─ mock? → mockKimi()
│   │       └─ real? → API call
│   │
│   ▼
│   [PatchEngine] → backup → apply files → guardrails pre-check
│       fail → rollback via manifest → state.failed_guardrails → STOP
│   │
│   ▼
│   [GitManager] → git diff --numstat
│   │
│   ▼
│   [Guardrails] → validateDiffSize (binary = reject), validateTestsPresent
│       fail → rollback via manifest → state.failed_guardrails → STOP
│   │
│   ▼
│   [Runner] → npm run lint/build/test...
│       fail → logs → next iteration (feedback + logs → Kimi)
│   │
│   ▼
│   [OpenAI Reviewer] → structured JSON review
│       ├─ mock? → mockReviewer()
│       └─ real? → API call
│   │
│   ▼
│   [StateManager] → save attempt results
│   │
│   ▼
│   verdict === 'approve'?
│   ├── YES → [GitManager.commit] (если auto_commit)
│   │         state.status = 'approved'
│   │         [Reporter.generateSummary]
│   │         STOP
│   └── NO (needs_changes) → feedback → next iteration
│
▼ END LOOP (max attempts reached)
│   state.status = 'failed_max_attempts'
│   [Reporter.generateSummary]
│   STOP
```

---

## 6. Контракты данных

### 6.1. `tasks.yaml`

```yaml
tasks:
  - id: contact-phone-validation
    title: "Add phone validation to contact form"
    repo_path: "../notguilty-legal"
    base_branch: "main"
    work_branch: "ai/contact-phone-validation"
    goal: >
      Add phone validation to the contact form without breaking
      Telegram, Google Sheets, Redis rate limit, or email fallback.
    context_files:
      - "src/components/ContactForm.tsx"
      - "src/app/api/contact/route.ts"
      - "src/lib/validation.ts"
    checks:
      - command: "npm"
        args: ["run", "lint"]
      - command: "npm"
        args: ["run", "build"]
    guardrails:
      allow_modify:
        - "src/components/ContactForm.tsx"
        - "src/lib/validation.ts"
      deny_modify:
        - ".env"
        - ".env.*"
        - "src/lib/telegram.ts"
        - "src/lib/googleSheets.ts"
        - "src/lib/redis.ts"
      max_lines_changed: 150
      require_tests: false
      auto_commit: false
      auto_push: false
      auto_merge: false
```

### 6.2. `KimiOutput` (JSON от Kimi)

```json
{
  "mode": "file_update",
  "files": [
    {
      "path": "src/lib/validation.ts",
      "content": "export function validatePhone(phone: string): boolean {\n  const ua = /^\\+380\\d{9}$/;\n  const local = /^0\\d{9}$/;\n  return ua.test(phone) || local.test(phone);\n}\n"
    }
  ],
  "notes": "Added phone validation without touching fallback logic."
}
```

### 6.3. `ReviewVerdict` (JSON от OpenAI)

```json
{
  "verdict": "needs_changes",
  "critical_issues": [
    "Phone validation rejects valid Ukrainian numbers without +380"
  ],
  "requested_changes": [
    "Allow 0XX XXX XX XX and +380 XX XXX XX XX formats",
    "Add error message near phone input"
  ],
  "summary_for_human": "The direction is correct, but validation is too strict."
}
```

---

## 7. CLI-интерфейс

```bash
# Запуск задачи
npx tsx src/cli.ts run contact-phone-validation

# Запуск в mock-режиме (без реальных API)
MOCK_AI=true npx tsx src/cli.ts run contact-phone-validation

# Продолжить прерванную задачу
npx tsx src/cli.ts resume contact-phone-validation

# Просмотр статуса
npx tsx src/cli.ts status contact-phone-validation

# Сбросить state и начать с чистого листа
npx tsx src/cli.ts reset contact-phone-validation
```

---

## 8. Mock-режим разработки

Для разработки и тестирования без реальных API-ключей предусмотрен mock-режим:

- `MOCK_AI=true` или флаг `--mock`.
- `src/mocks/mock-kimi.ts` — возвращает заранее заготовленный `KimiOutput`.
- `src/mocks/mock-reviewer.ts` — возвращает заранее заготовленный `ReviewVerdict`.
- Mock-данные можно переключать сценариями: `success`, `needs_changes`, `reject`, `guardrails_fail`.

Это позволяет прогнать весь pipeline локально до подключения реальных ключей.

**Первый кодовый этап — только mock mode.** Реальные API не подключаются.

---

## 9. Что НЕ входит в MVP

| Фича | Причина откладывания |
|------|---------------------|
| Web UI | Утонем во фронтенде |
| GitHub Actions trigger | Сначала стабильный локальный CLI |
| Auto-push / auto-PR | Безопасность, контроль человека |
| Auto-merge | Категорически нет |
| Telegram / Slack уведомления | Потом, если понадобится |
| RAG / codebase indexing | Достаточно ручных context_files |
| Diff-mode (git apply) | File mode надёжнее |
| AST-анализ для guardrails | Простые glob-паттерны достаточны |

---

## 10. Ключевые принципы безопасности

1. **Deny by default.** Если `allow_modify` указан — всё остальное запрещено.
2. **Guardrails перед применением.** Проверять до перезаписи файлов.
3. **Guardrails после diff.** Проверить `git diff --numstat` на объём + отклонить binary файлы.
4. **Никаких destructive операций.** Нет `rm -rf` (кроме удаления новых файлов при rollback), нет `git push`, нет `git merge`, нет `git clean -fd`.
5. **Backup перед patch.** `PatchEngine` делает backup в `attempt-N/files-before/` и ведёт `patch-manifest.json`.
6. **State — единственный источник правды.** Всегда можно восстановить, что происходило.
7. **Path traversal защита.** Никаких `../../../etc/passwd`, absolute paths запрещены.
8. **Rollback корректный.** Если файл существовал — восстановить из backup. Если создан новый — удалить.
