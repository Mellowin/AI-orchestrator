# Autopilot Plan — mission intake

`autopilot-plan` превращает человеческую цель в готовый конфиг для `autopilot-run`.

```bash
npx tsx src/cli.ts autopilot-plan configs/mission.example.json
npm run autopilot:plan -- configs/mission.example.json
```

## Зачем это нужно

- `mvp-run` требует готовый список задач.
- `diagnose-ci` требует настройки репозитория и CI.
- `autopilot-run` объединяет их, но всё ещё требует JSON-конфиг.

`autopilot-plan` убирает последний ручной шаг: оператор передаёт только цель, а инструмент генерирует все артефакты.

## Что генерируется

В `reports/autopilot-plans/<run_id>/`:

- `mission.md` / `mission.json` — исходная миссия.
- `plan.md` / `plan.json` — сгенерированный план (задачи, риски, включена ли диагностика/починка).
- `mvp-run.config.json` — конфиг для `mvp-run`.
- `autopilot.config.json` — конфиг для `autopilot-run`.
- `operator-command.md` — точная команда для запуска.

## Режимы

### `fake` (безопасный по умолчанию)

- Не вызывает реального провайдера.
- Не применяет изменения к репозиторию.
- Не создаёт PR, не ждёт CI, не чинит.
- Подходит для демонстрации и локальных проверок.

### `github` (реальный режим)

Включает возможности только если в `capabilities` явно разрешены:

- `allow_real_provider` — вызов Kimi для генерации плана.
- `allow_repo_apply` — разрешить применение патчей.
- `allow_repo_commit` — разрешить коммиты.
- `allow_repo_push` — разрешить push.
- `allow_pr_create` / `allow_pr_update` — работа с PR.
- `allow_actions_read` — чтение GitHub Actions.
- `allow_repair` — цикл починки после красного CI.

Если режим `fake`, все write-возможности принудительно отключены, независимо от `capabilities`.

## Токены

- В `fake`-режиме токены не требуются.
- В `github` с `allow_real_provider=true` нужен `KIMI_API_KEY` (или переменная из `provider.token_env`).
- В `github` с `allow_actions_read=true` нужен `GITHUB_TOKEN` (или переменная из `github.token_env`).
- Токены никогда не печатаются и не сохраняются в артефактах.

## Пример миссии

```json
{
  "run_id": "mission-demo",
  "repo_slug": "Mellowin/AI-orchestrator",
  "repo_path": ".",
  "base_branch": "main",
  "goal": "Add a small documentation note proving mission intake can generate an autopilot config.",
  "mode": "fake",
  "capabilities": {
    "allow_real_provider": false,
    "allow_repo_apply": false,
    "allow_repo_commit": false,
    "allow_repo_push": false,
    "allow_pr_create": false,
    "allow_pr_update": false,
    "allow_actions_read": false,
    "allow_repair": false
  },
  "output_dir": "reports/autopilot-plans"
}
```

## One-click wrapper

For a single command that turns a raw goal into a plan and immediately runs autopilot, see `docs/ONE_CLICK.md`.

## Следующий шаг

После генерации запустите:

```bash
npx tsx src/cli.ts autopilot-run reports/autopilot-plans/<run_id>/autopilot.config.json
```

## Ограничения

- План в `fake`-режиме детерминирован и примитивен.
- `autopilot-plan` не ждёт CI и не мутирует репозиторий.
- Реальный план зависит от качества ответа провайдера; плохой JSON отклоняется.
