# Product Vision — Message for Kimi Coder

> This document exists so that the orchestrator can pass the real product goal to Kimi on every block run. It prevents drift into "more demos", "more docs", or "more PR status reports".

## Главная цель проекта

Сделать автономную программу, которая сама ведёт блок маленьких задач разработки через AI-агентов.

## Как я хочу, чтобы это работало

1. Я создаю блок задач, например 5–10 маленьких задач.
2. Программа берёт первую задачу.
3. Программа отправляет задачу AI-кодеру.
4. AI-кодер пишет код.
5. Программа применяет изменения, запускает проверки, делает commit и push.
6. Программа получает полный commit hash.
7. Программа сама проверяет commit/diff/status.
8. Программа отправляет фактические данные AI-ревьюеру.
9. AI-ревьюер принимает решение:
   - **accepted** — задача закрыта, программа берёт следующую задачу;
   - **rejected** — программа формирует fix-task и отправляет обратно AI-кодеру.
10. Так продолжается, пока весь блок задач не будет закрыт.
11. В конце программа создаёт отчёт по блоку: какие задачи были, какие commit hash, что принято, что исправлялось, где PR/статус.

## Очень важно

Я не хочу быть посредником между кодером и ревьюером.

Сейчас я вручную копирую тебе задачу, потом копирую commit hash в ChatGPT, потом получаю ревью, потом снова даю тебе следующую задачу. В будущем это должна делать сама программа.

То есть человек должен только:
- создать блок задач;
- настроить AI-провайдеров;
- запустить автономный блок;
- в конце посмотреть итоговый отчёт / PR / status.

Человек НЕ должен:
- вручную передавать каждую задачу между AI;
- вручную копировать каждый commit hash;
- вручную спрашивать reviewer после каждой задачи;
- вручную решать, какую следующую маленькую задачу дать, если предыдущая accepted.

## Роли в системе

1. **Coder AI** — пишет код.
2. **Reviewer AI** — проверяет фактический commit, diff, changed files, tests, build, safety rules.
3. **Fixer AI** — исправляет задачу, если reviewer отклонил.
4. **Orchestrator** — управляет всем циклом: task → coder → checks → commit → reviewer → next/fix.
5. **Deterministic verifier** — жёстко проверяет правила до AI-review:
   - changed files только разрешённые;
   - tests/typecheck/build passed;
   - branch не main;
   - нет .env/secrets;
   - нет merge;
   - нет force push;
   - нет checkout/switch внутри tool;
   - commit существует;
   - git status clean.

AI-reviewer не должен верить словам AI-кодера. Он должен смотреть реальные факты: commit hash, diff, changed files, test result, safety findings.

## Первый реальный target

Сначала делаем:
- **Kimi as Coder**
- **Kimi as Reviewer**

То есть один Kimi API key может использоваться в двух ролях, но с разными prompts:
- coder prompt — написать код;
- reviewer prompt — строго проверить commit.

## Потом архитектура должна позволять комбинации

- Kimi пишет код, Kimi ревьюит;
- Kimi пишет код, Claude ревьюит;
- Claude пишет код, Gemini ревьюит;
- Gemini пишет код, OpenAI ревьюит;
- DeepSeek пишет код, Kimi ревьюит;
- несколько reviewers одновременно;
- несколько coders, где система выбирает лучший результат.

Поэтому проект нельзя хардкодить только под Kimi. Kimi — первый implemented provider, но архитектура должна быть multi-provider.

## Что важно НЕ делать

- Не превращать проект просто в demo script.
- Не делать только красивые документы.
- Не делать просто ручной ChatGPT-review flow.
- Не делать только Kimi wrapper.
- Не делать merge bot.
- Не трогать main автоматически.
- Не добавлять auto-merge.
- Не добавлять опасные действия без отдельного safety design.

## The key product sentence

> This project is an autonomous AI development orchestrator where users can combine AI providers for coding, reviewing, fixing and planning, while the system enforces deterministic safety checks and reviewer gates before advancing through a block of tasks.
