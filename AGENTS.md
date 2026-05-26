# AGENTS.md — AI Orchestrator

## Назначение проекта

AI Orchestrator — автономный Node.js CLI-инструмент (TypeScript, ES Modules), который берёт задачи из `tasks.yaml`, выполняет код через Kimi API, ревьюит через OpenAI API, прогоняет lint/build/test и сохраняет состояние в `runs/`.

**Главное правило:** оркестратор никогда не делает `git push`, `merge` и не трогает `main` напрямую.

---

## Роль агента

Ты — инженер, реализующий и поддерживающий AI Orchestrator. Твоя задача: писать типизированный, модульный, минималистичный код, который следует архитектуре из `ARCHITECTURE.md`.

---

## Технический стек и ограничения

- **Runtime:** Node.js 20+
- **Language:** TypeScript, ES Modules (`"type": "module"`)
- **Запуск:** `npx tsx src/cli.ts ...` (dev), `node dist/cli.js` (prod)
- **Фреймворки:** не использовать
- **БД:** не использовать
- **Веб-интерфейс:** не делать
- **Git:** работа только через `child_process`, никаких wrapper-библиотек

---

## Что можно делать

- Создавать и изменять файлы в `src/`, `prompts/`, `tasks.yaml`
- Добавлять dev-зависимости (`typescript`, `tsx`, `@types/node`)
- Добавлять runtime-зависимости (`yaml`, `dotenv`, `openai`)
- Писать mock-реализации в `src/mocks/`
- Создавать тестовые `tasks.yaml` для проверки pipeline
- Обновлять `ARCHITECTURE.md` и этот файл при изменении архитектуры

## Что НЕЛЬЗЯ делать

- **Никакого `git push`, `git merge`, работы с `main` напрямую.**
- **Никаких destructive файловых операций:** нет `rm -rf`, нет `fs.rmdir` без проверок.
- **Никаких `eval`, `new Function`, `child_process.exec` с пользовательскими строками.**
- **Не менять логику guardrails:** всегда deny-by-default, всегда проверка до и после.
- **Не добавлять в MVP:** Web UI, GitHub Actions, auto-push, auto-merge, Telegram/Slack, RAG.
- **Не писать код вне `src/`** (кроме конфигурационных файлов в корне).

---

## Workflow: как вносить изменения

1. **Читай `ARCHITECTURE.md`** перед изменением модуля.
2. **Обновляй `src/types.ts`** если меняешь контракт данных.
3. **Минимальные изменения:** не рефакторь соседние модули без причины.
4. **Mock-режим:** если пишешь модуль, зависящий от API, сразу добавь mock-версию в `src/mocks/`.
5. **Типизация:** строгий TypeScript (`strict: true`). Никаких `any` без крайней необходимости и комментария.
6. **Ошибки:** используй кастомные `Error` с понятными сообщениями. Не глушай ошибки.

---

## State-Driven Development

`runs/{task_id}/state.json` — единственный источник правды о прогрессе задачи.

- При любом изменении этапа — вызывай `stateManager.save()`.
- Если скрипт упал, при повторном `run`/`resume` он должен прочитать `state.json` и продолжить.
- Не храни состояние в глобальных переменных между вызовами CLI.

---

## Git-правила для целевого репозитория

Целевой репозиторий — это `repo_path` из `tasks.yaml`, НЕ корень `ai-orchestrator`.

- Перед стартом: `ensureClean(repoPath)` — STOP если есть uncommitted changes.
- Ветка: создаём `work_branch` от `base_branch`.
- Commit: только если `guardrails.auto_commit === true`.
- Никакого push/merge.
- Rollback внутри attempt: через backup в `attempt-N/files-before/`, а не через `git reset --soft`.
- `git restore .` + `git clean -fd` используется только для ensureClean перед стартом.

---

## AI API: правила работы

### Kimi (Coder)
- Endpoint: `https://api.moonshot.cn/v1` (default) или env `KIMI_BASE_URL`.
- Model: `kimi-k2.6`.
- Temperature: `0.1`.
- Парсинг: всегда извлекай JSON из markdown-блока, валидируй по `KimiOutput`.
- Если parse fail — пиши сырой ответ в `attempt-N/kimi-raw.md` и возвращай ошибку.

### OpenAI (Reviewer)
- Model: `gpt-4o` или `gpt-5.5`.
- Temperature: `0`.
- Structured Output: `response_format: { type: 'json_schema', schema: ... }`.
- Всегда возвращает `ReviewVerdict`.

### Mock-режим
- Переменная `MOCK_AI=true` или флаг `--mock`.
- Mock-функции живут в `src/mocks/mock-kimi.ts` и `src/mocks/mock-reviewer.ts`.
- Сценарии mock: `success`, `needs_changes`, `reject`, `guardrails_fail`.

---

## Тестирование

- **Unit:** каждый модуль можно протестировать изолированно, импортируя его из `src/`.
- **Integration:** mock-режим позволяет прогнать полный pipeline без API-ключей.
- **E2E:** создай тестовый git-репозиторий, добавь задачу в `tasks.yaml`, запусти с `MOCK_AI=true`.

---

## Структура коммитов (если auto_commit)

Если в задаче `auto_commit: true`, формат сообщения:

```
ai-orchestrator: {task_id} attempt {N}

- Status: {status}
- Verdict: {verdict}
```

Но по умолчанию `auto_commit: false` — коммиты делает человек.

---

## Документация

- `ARCHITECTURE.md` — описание модулей, data flow, контракты.
- `AGENTS.md` — этот файл: правила для AI-агентов.
- При изменении архитектуры обновляй **оба** файла.

---

## Human-in-the-loop

Человек вмешивается только когда:
- Pipeline остановился на `failed_guardrails`
- Pipeline остановился на `rejected`
- Pipeline остановился на `failed_max_attempts`
- Pipeline завершился на `approved` (человек смотрит `summary.md` и решает, push-ить ли вручную)

Промежуточные `needs_changes` гоняются автоматически Reviewer → Coder.

---

## Памятка по безопасности

1. Guardrails **до** применения файлов.
2. Guardrails **после** git diff.
3. Backup **перед** patch.
4. Path traversal check на каждый файл.
5. Deny-by-default если `allow_modify` указан.
6. Никакого `git push`, `merge`, работы с `main`.
