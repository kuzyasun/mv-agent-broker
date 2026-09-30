# Multi-Vendor Agent Broker — специфікація MVP

**Версія:** 0.2  
**Дата:** 2026-09-29  
**Статус:** переглянутий проєкт специфікації після review v0.1; готовий як основа P0 та повторного review. Implementation contract і support matrix не затверджені до проходження P0.  
**Робоча назва:** Agent Broker.  
**Формат реалізації:** локальний deterministic execution/session layer із MCP-інтерфейсом.  
**Попередня редакція:** 0.1; **API цієї редакції:** `0.2`.

> Контекст агента — ресурс, який потрібно зберігати та повторно використовувати. Broker має показувати, яку native conversation продовжено, який turn виконано, на якій версії workspace та з якими доказами результату. Він не повинен приховувати втрату контексту, невизначеність виконання чи заміну provider-а.

## 0. Основа документа та статус рішень

Безпосередня основа цієї редакції:

- **[SRC-03]** `multi-vendor-agent-broker-mvp-v0.1(1).md`, специфікація MVP v0.1 від 2026-09-29. SHA-256: `fa432237a5b83ecbb3c533843fcc0cdfedaa0b22ece3836c2c4a18c6df87d567`.
- **[SRC-04]** `multi-vendor-agent-broker-mvp-v0.1-review.md`, незалежне статичне review від 2026-09-29. SHA-256: `c6df4440baef3d17d9d4245032846e49f0775efb67dd1659e45a435c7d508503`. Findings R01–R08 та уточнення P0 у §5 review є підставою змін v0.2.

Успадкований контекст, описаний у [SRC-03]: **[SRC-01]** — `multi-vendor-agent-broker-idea(1).md`, «Ідея: Multi-Vendor Agent Broker / Orchestrator через MCP»; **[SRC-02]** — попередній review концепту в розмові від 2026-09-29. Посилання на них збережено як provenance попередніх рішень; у v0.2 ці два джерела не перевірялися повторно незалежно від [SRC-03].

**Походження вимог.** Мета, межа відповідальності та основна структура успадковані з [SRC-03]. Зміни за [SRC-04] внесено до нормативних розділів, API, recovery та acceptance matrix, а не лише до переліку рекомендацій. Конкретні guards, коди помилок, input manifest, pinning rules і default limits, яких немає дослівно у review, — **проєктні рішення v0.2 для закриття його findings**, а не повідомлення про реалізовані або перевірені можливості. Трасування змін наведено у §0.3.

Документ не є новим аудитом сторонніх репозиторіїв чи актуальних CLI. У цій редакції не виконувалися native smoke tests і не перевірялися vendor capabilities. Конкретні flags, SDK signatures, версії runtime та спосіб enforcement потрібно зафіксувати на P0; непідтверджена можливість має статус `unknown`. Закриття finding у тексті **не означає** проходження відповідного тесту реалізацією.

У цьому документі **MUST / MUST NOT** означають обов’язкову вимогу для MVP після затвердження специфікації; **SHOULD** — рекомендовану вимогу з документованим винятком; **MAY** — необов’язкову можливість. Вони описують запропонований контракт, а не поточну реалізацію.

### 0.1. Що змінено порівняно з концептом

| Початкова ідея | Рішення для MVP | Походження |
|---|---|---|
| Один pool для різних coordinator-ів і CLI | Один локальний runtime; кілька MCP bridges; дві початкові provider integrations | [SRC-01], звуження цієї редакції |
| Persistent worker і reviewer | Broker session + native conversation + окремі turns; process може завершуватися | [SRC-02] |
| Session як основна сутність | Session залишається основною довгоживучою сутністю; turn — одиниця виконання | [SRC-02] |
| `readonly / shared_checkout / worktree / sandbox` | Незалежні workspace, access, sandbox та tool/network policies | [SRC-02] |
| Кілька writer-ів у різних директоріях shared checkout | У MVP один writer на workspace; паралельні writer-и — в різних worktree | [SRC-02] |
| Reviewer перевіряє latest changes | Reviewer перевіряє конкретні immutable snapshots | [SRC-02] |
| Економія токенів через reuse | Гіпотеза, яку потрібно виміряти; жодної гарантованої економії | [SRC-02] |
| `agent-pool-mcp` як попередня основа fork | Базовий fork не затверджено; spike → рішення за результатами | [SRC-02] |
| Resume, pause, fork, generic CLI | Native resume — MUST; pause/steer/fork/generic CLI — поза MVP | Звуження цієї редакції |

### 0.2. Навігація

| Частина | Розділи |
|---|---|
| Призначення і scope | [1. Мета](#1-мета-та-основний-користувацький-сценарій), [2. Межі](#2-межі-mvp), [3. Інваріанти](#3-незмінні-правила-системи) |
| Execution contract | [4. Архітектура](#4-архітектура-та-ownership), [5. Дані](#5-модель-даних), [6. Lifecycle](#6-lifecycle-sessions-і-turns), [7. Admission](#7-task-contract-admission-та-idempotency) |
| Код і review | [8. Workspaces](#8-workspace-access-і-locks), [9. Snapshots](#9-snapshot-based-review) |
| Зовнішній інтерфейс | [10. MCP API](#10-mcp-api-v02), [11. Results](#11-result-contract-та-доказовість) |
| Межі та збої | [12. Security](#12-permissions-secrets-і-trust-boundary), [13. Adapters](#13-provider-adapter-contract), [14. Recovery](#14-persistence-recovery-та-quiescence) |
| Реалізація | [15. Limits](#15-resource-limits-observability-та-retention), [16. Workflow](#16-наскрізний-mvp-workflow), [17. Етапи](#17-план-реалізації-та-decision-gates) |
| Приймання і review | [18. Tests](#18-acceptance-matrix), [19. Ефективність](#19-перевірка-гіпотези-context-reuse), [20. Питання reviewer-у](#20-питання-для-незалежного-reviewer-а) |

### 0.3. Зміни v0.2 та трасування review

| Підстава [SRC-04] | Рішення v0.2 | Основні розділи | Нові / уточнені acceptance tests |
|---|---|---|---|
| R01 — artifact input delivery | Кожен `artifact_refs` є required input; ACL/sealed-state checks, atomic pins, `TurnInputManifest`, bounded inline або enforced read-only materialization перед dispatch | §5.6, §7.1.1, §12.6, §13.2.1 | A34–A36, A49, A50 |
| R02 — coverage нових source files | Source prefixes охоплюють майбутні untracked files; окремі non-source outputs; pre/post inventory і coverage failure; однаковий coverage contract для review | §8.7, §9.1–§9.2, §9.5 | A37–A39, A49 |
| R03 — concurrent idempotency | Authoritative lookup та final admission серіалізовані; uniqueness conflict перетворюється на replay/conflict; чинна авторизація обов’язкова | §7.2–§7.3 | A02–A04, A40–A42 |
| R04 — blocked-session close | Guarded `BLOCKED → CLOSED`; durable close intent; звільнення logical-session cap без обходу `UNKNOWN` чи видалення workspace | §6.4–§6.5, §14.5 | A43–A44, A52 |
| R05 — transition completeness | Нормативні session/turn transition tables, terminal selection та єдиний release protocol | §6.2, §6.5, §14.6 | A45, A52 |
| R06 — singleton/recovery barrier | Lifetime-exclusive state ownership; `RECOVERING` до відновлення reservations/quarantines; fencing stale callbacks | §4.1.1, §14.7 | A46–A47 |
| R07 — bootstrap IDs | Project-scoped paginated discovery в `agents_list`; дозволені projects у `broker_status`; жодних нових admin MCP tools | §4.3, §10.1.2, §16.1 | A48 |
| R08 — довга session / storage | Content-addressed snapshot blobs; явні pin roots; metadata refs не дорівнюють pins; operator cleanup без reset native context | §5.7, §14.1, §15.3 | A49, A51 |
| §5 review — повний P0 gate | Обов’язкові worker/reviewer profiles перевіряються цілісно: continuity, inputs, restrictions, snapshot refresh і quiescence | §13.1, §17, §18.1 | A12, A14, A21, A34, A50, A53 |

Усі R01–R08 **опрацьовані на рівні специфікації**. Статус реалізації та тестів: **не виконано в межах підготовки цього документа**. Scope MVP не розширено до routing, DAG, automatic retry/merge, semantic memory або independent test runner.

**Сумісність:** API позначено `0.2`, оскільки змінено discovery responses, stop semantics, обов’язкові bindings/results та errors. Назви наявних tools збережені; `artifact_refs` залишається масивом IDs. Автоматичного downgrade до `0.1` немає. Для ще не створеної реалізації migration не заявляється; якщо існує prototype v0.1, його сумісність і migration мають бути перевірені окремо.

---

## 1. Мета та основний користувацький сценарій

Користувач уже має coordinator-а в Codex, Claude Code, Cursor або іншому MCP-compatible host. Цей coordinator знає план і делегує частини роботи зовнішнім CLI-агентам, використовуючи явно вибрані provider, account profile, model і роль.

Broker потрібен, щоб один worker і один reviewer могли послідовно працювати над пов’язаними задачами, зберігаючи власні native conversations, незалежно від тривалості окремого CLI-процесу або MCP-підключення.

```text
Будь-який підтриманий MCP coordinator
    │
    ├── Worker session A, provider X: implement
    ├── Reviewer session B, provider Y: review snapshot S1
    ├── Та сама Worker session A: fix findings
    ├── Та сама Reviewer session B: verify snapshot S2
    └── Та сама Worker session A: наступний пов’язаний task
```

Worker і reviewer не спілкуються між собою через прихований workflow. Coordinator отримує результати й явно надсилає наступні tasks. Після завершення роботи він закриває sessions; результати та native history не видаляються автоматично.

### 1.1. Межа відповідальності

| Coordinator | Broker | Provider adapter / CLI |
|---|---|---|
| План, decomposition, вибір ролі та model | Валідація запиту та user policy | Vendor-specific execution protocol |
| Вибір reuse або нової session | Registry sessions, turns і resources | Створення/продовження native conversation |
| Рішення про retry, review, escalation | Ідемпотентне прийняття, locks, process supervision | Streaming events, cancellation, usage |
| Оцінка якості й достатності тестів | Snapshot/diff, evidence, compact results | Інструменти coding agent-а |
| Merge/reject та подальші задачі | Чесні errors/recovery, без прихованих fallback | Native auth без експорту credentials |

Broker MUST NOT запускати LLM для routing, summarization, планування, визначення «найкращого» worker-а чи прийняття результату. Валідація policy і механічне формування context envelope не є новим orchestration layer.

---

## 2. Межі MVP

### 2.1. Входить

MVP включає один локальний daemon, тонкий stdio MCP bridge, durable registry, два provider adapters, послідовне продовження native conversations, неблокувальні turns, bounded result/event retrieval, cancellation, консервативний recovery, current/worktree workspace, snapshot-based review, resource limits і evidence-aware results.

**Початкова пара adapters — Codex і Claude Code.** Це запропонований вибір за [SRC-02], а не обіцянка, що всі потрібні властивості цих CLI вже перевірено. Кожен adapter має пройти однакові contract tests. Невдала перевірка не дозволяє непомітно підмінити native resume передаванням summary у нову conversation.

Coordinator independence потрібно продемонструвати хоча б у двох MCP hosts: один workflow із Codex як coordinator, інший — із Claude Code. Це перевірка MCP surface, а не вимога до прихованої синхронізації їхніх контекстів.

### 2.2. Не входить

Поза MVP залишаються smart routing, DAG engine, automatic review/retry/merge, semantic memory, власний agent runtime, web UI, remote/SSH workers, multi-user SaaS, платіжна система, автоматичне перемикання підписок, private IDE IPC та API fallback.

Також відкладено provider adapters Cursor/Antigravity/ZCode, generic PTY adapter, native fork, steering активного turn, pause/resume активного виконання, concurrent turns однієї session, паралельні writer-и одного checkout, власний незалежний test runner і автоматичне перепакування старого контексту.

Відкладені можливості не повинні існувати як працюючі API-заглушки з оманливим `success`.

### 2.3. Робочі припущення

**Запропонований стек:** TypeScript, Node.js із зафіксованою підтримуваною LTS-версією, SQLite, файлове artifact storage, Git для code workspaces. Конкретні бібліотеки й версії вибираються та pin-яться на P0; цей документ не встановлює їхніх актуальних номерів.

**Запропонована platform boundary:** macOS та Linux runtime; Windows через Linux-середовище WSL2. Native Windows process supervisor — не MVP. Кожен platform/provider pair отримує окремий verified status; неперевірена платформа не рекламується як supported. Для WSL CLI, Git, daemon і project workspace повинні працювати в одному Linux-середовищі; змішування Windows CLI та Linux process control не входить у контракт.

**Deployment:** один оператор, одна машина, один user-scoped daemon і локальна файлова система. База даних, sockets і broker state не розташовуються в синхронізованій knowledge base або Git checkout. Віддалені/network filesystem deployment-и не входять у MVP.

**Безпека:** це інструмент роботи з дозволеними користувачем coding CLI, а не доказово захищене середовище для ворожого коду. Обмеження цього threat model описані в розділі 12.

---

## 3. Незмінні правила системи

| ID | Інваріант |
|---|---|
| INV-01 | Одна session має не більше одного незавершеного turn, включно зі станом `UNKNOWN`. |
| INV-02 | Один workspace має не більше одного broker-owned writer; snapshot capture та source readers також координуються locks. |
| INV-03 | Повторний mutating request із тим самим idempotency key не створює новий ефект. |
| INV-04 | Невідомий результат виконання не прирівнюється до невиконання. |
| INV-05 | Resume failure ніколи автоматично не перетворюється на нову conversation. |
| INV-06 | Provider, account, model, effort і permissions не змінюються через прихований fallback. |
| INV-07 | Reviewer працює з явно визначеною парою baseline/target snapshots, а не з moving checkout. |
| INV-08 | Agent-reported, broker-observed та оцінка якості — різні рівні даних. |
| INV-09 | Збереження broker metadata не оголошується резервною копією native conversation. |
| INV-10 | MCP disconnect не є командою скасувати turn. |
| INV-11 | Locks і capacity не звільняються лише через втрату heartbeat або сплив TTL процесу. |
| INV-12 | Немає автоматичного reset/clean/stash/merge/commit чи видалення dirty worktree. |
| INV-13 | User policy має вищий пріоритет за бажання coordinator-а; непідтримувана обов’язкова capability — помилка. |
| INV-14 | Broker не гарантує exactly-once зовнішніх дій агента або економію токенів. |
| INV-15 | Worker output, repository instructions і артефакти не отримують права змінювати broker policy. |

---

## 4. Архітектура та ownership

```text
Codex / Claude Code / інший MCP host
                 │ stdio MCP
                 ▼
     Bridge: presentation + bounded RPC
                 │ private local IPC
                 ▼
        Один user-scoped Broker daemon
        ├── authentication / project binding
        ├── session + turn service
        ├── admission / locks / reconciliation
        ├── workspace / snapshots / evidence
        ├── adapter: Codex
        └── adapter: Claude Code
                 │
       native CLI runtimes / conversations

Daemon → SQLite metadata + durable events
       → protected artifact storage
       → broker-managed workspaces
```

### 4.1. Daemon і bridge

Daemon володіє processes, registry, locks та execution decisions, які не потребують LLM. Bridge тільки перетворює MCP requests/responses на локальні виклики daemon-а. Кілька bridges MUST підключатися до того самого daemon-а, а не створювати незалежні task stores.

Для MVP пропонується private Unix-domain socket із user-only permissions. Локальний RPC повинен мати version handshake, обмеження розміру message і аутентифікацію, налаштовану оператором. Він не слухає публічний TCP interface. Формат внутрішнього framing — деталь реалізації; MCP contract від нього не залежить.

Bridge не має права відновлювати execution, запускати adapter без daemon-а або повторювати мутацію з новим idempotency key. Відсутній daemon дає явну помилку. Автоматичне встановлення system service не виконується через MCP tool.

### 4.1.1. Singleton ownership та readiness

MVP має один налаштований canonical state directory на OS user. Daemon MUST отримати lifetime-exclusive OS-backed ownership цього directory **до** відкриття mutable registry, створення/заміни socket або виконання recovery side effects. Lock має утримуватися протягом усього життя daemon-а; PID file, наявність socket, heartbeat або TTL не є достатнім ownership mechanism. Конкретний platform primitive обирається та тестується на P0/P1.

Другий daemon, зокрема запущений через alias того самого directory, MUST завершити startup із `DAEMON_ALREADY_RUNNING`. Не можна забирати ownership через «старий» heartbeat, видаляти lock file чи unlink-ити socket, яким володіє ще живий daemon. Спроба відновити завислий daemon потребує явної operator action; одночасний запуск другого owner-а не є recovery.

`daemon_state`: `RECOVERING`, `READY`, `FAILED`, `STOPPING`. Після отримання ownership daemon входить у `RECOVERING`, створює новий durable `daemon_incarnation` та відновлює registry, intents, reservations, input pins і workspace quarantines за §14.7. Лише завершення цієї barrier дозволяє `READY` і новий admission.

У `RECOVERING`/`FAILED` дозволені bounded status/diagnostics і авторизоване читання вже committed records; відповідь позначає, що runtime observations ще не підтверджені. Replay уже durable operation MAY повертати тільки existing state, без продовження side effects. Нові mutating operations через MCP повертають `DAEMON_NOT_READY`; recovery дії виконує лише control plane, не bridge. У `READY` можуть залишатися quarantined workspaces та blocked sessions: barrier вимагає відновити їхній захист, а не обов’язково розв’язати всі `UNKNOWN`.

Кожен callback/RPC, що змінює execution metadata, перевіряється за daemon/runtime incarnation і record revision. Втрата ownership або непідтверджена цілісність fencing переводить daemon у fail-closed стан: жодного нового dispatch. Fencing metadata не зупиняє зовнішні процеси та не замінює quiescence.

### 4.2. Identity та кілька coordinator-ів

`coordinator_id` — стабільний локальний profile, налаштований оператором для bridge, а не довільний аргумент model-а. Він переживає reconnect. Profile прив’язаний до дозволених `project_id` і operation permissions.

Session має одного `owner_coordinator_id`. Інші coordinator profiles можуть бачити лише явно дозволені metadata; send/cancel/close чужої session за замовчуванням заборонені. Передавання ownership — operator-only action для idle session, не приховане рішення моделі.

Два bridges одного owner-а можуть працювати одночасно. Конкуренція вирішується транзакційно через session/turn locks і idempotency, а не припущенням «у coordinator-а завжди одне вікно».

Локальний profile є засобом контролю доступу продукту. Він не створює hard security boundary між довільними процесами того самого OS user.

### 4.3. Registered projects

Operator локально реєструє project root, дозволені account profiles, workspaces та policy profiles. MCP API приймає `project_id` і зареєстровані workspace references, а не будь-який абсолютний `cwd`.

Daemon canonicalizes paths, перевіряє symlinks і забороняє доступ поза allowlist. Broker state, credentials та сторонні projects не можуть стати workspace через task text або artifact path.

`broker_status` повертає лише дозволені поточному bridge project IDs; `agents_list(project_id)` надає project-scoped bootstrap manifest із зареєстрованими workspace, account і policy IDs, їхніми versions, допустимими roles та capability status (§10.1.2). Coordinator не повинен вигадувати ці IDs або отримувати credentials для discovery. Discovery не реєструє нові resources і не розширює ACL.

---

## 5. Модель даних

### 5.1. Чотири різні поняття

**Broker session** — тривала логічна identity агента: owner, project, provider, account profile, model, роль, instructions, permissions, workspace і послідовність turns.

**Native conversation** — vendor-specific history/context, на яку вказує opaque `native_conversation_ref`. Вона належить конкретному provider/profile; broker не переносить її на інший provider.

**Runtime/process** — поточний процес або process tree adapter-а. Він може бути відсутній між turns. У MVP один runtime не обслуговує одночасно кілька незалежних broker sessions: це спрощує cancellation та ownership.

**Turn** — одне явно прийняте виконання task у session. Воно має власний ID, input, state, deadline, context binding, output/evidence і termination reason.

### 5.2. Session record

| Група | Обов’язкові дані |
|---|---|
| Identity | `session_id`, `project_id`, `owner_coordinator_id`, timestamps, `record_version` |
| Provider | adapter ID/version, CLI version, account profile ID, auth mode без credentials |
| Configuration | requested та effective model/effort, role, instructions hash, policy profile/version |
| Context | native conversation ref або `null`, `context_status`, останній успішний turn/snapshot |
| Workspace | workspace ID, canonical path reference, mode, access, coverage profile ID/version/contract hash, enforcement metadata |
| Lifecycle | session state, active turn ID, block reason, runtime reference або `null`, `close_state`, close intent/result reference |

Provider/account/model/effort, роль, instructions, policy/coverage binding і privileges є незмінними в межах session. Для іншої конфігурації створюється нова session явно. Provider-controlled compaction не вважається створенням нової conversation, але її подію потрібно показати, коли adapter може її спостерігати.

Coverage binding resolve-иться під час spawn із зареєстрованого workspace/project profile та повертається в status. Для нового `review_slot` використовується coverage binding, явно заданий у дозволеному project/reviewer policy profile, навіть до першого target snapshot; перший review не змінює його приховано.

`context_status`: `not_started`, `available`, `unverified`, `missing`. Це окреме поле від process state. `available` означає останню підтверджену доступність native conversation, а не гарантію, що model дослівно пам’ятає весь попередній transcript.

### 5.3. Turn record

Turn містить `turn_id`, session/project/owner references, idempotency key і canonical request hash, task contract, requested/effective execution settings, state, state version, timestamps, deadline, runtime evidence, baseline/target snapshot references, input manifest ID/hash, required artifact pins, source inventory references, event cursor, result reference та completion/error reason. `native_outcome`, `termination_reason`, `finalization_error` і `execution_started` зберігаються окремо: failed evidence capture не має стирати факт cancellation або provider completion.

Task text і context можуть містити приватні дані; вони зберігаються в protected artifacts. Звичайний status повертає їхні IDs/hashes і bounded preview, а не весь prompt.

### 5.4. Snapshot та Artifact

`Snapshot` — immutable manifest файлів у явно визначеному coverage profile плюс content hashes і зв’язок із project/workspace. Він не є native conversation і не означає snapshot усього OS environment. Coverage binding містить `coverage_profile_id`, `coverage_profile_version` і `coverage_contract_hash` — hash канонічних правил source selection, classification, exclusions та entry semantics; це не hash переліку файлів конкретного capture.

`snapshot_id` — opaque identity конкретного capture. Окремий `source_digest` обчислюється як SHA-256 канонічного впорядкованого source manifest: relative path, entry type, executable bit, content hash і coverage profile ID/version/contract hash. Timestamps, capture ID та абсолютний staging path у source digest не входять. Workspace precondition порівнює фактичний source digest і coverage зі збереженим snapshot, а не вимагає рівності IDs двох різних captures; HEAD/index guards перевіряються окремо.

`Artifact` — immutable після sealing об’єкт: snapshot manifest/content, patch, redacted log, structured report або result. Доступ до нього визначає daemon; caller передає `artifact_id`, не файловий шлях.

### 5.5. Пов’язані registry entities

MVP також має `Project`, `AccountProfile`, `CoordinatorProfile`, `Workspace`, `PolicyProfile`, `RuntimeInstance`, `ResourceReservation`, `Event`, `IdempotencyRecord`, `ArtifactPin` та provisioning/close/launch intents. Це записи локального control plane, не окремі мікросервіси.

### 5.6. TurnInputManifest

`TurnInputManifest` — broker-generated, versioned manifest конкретного turn; його sealed reference записується до task dispatch. Він містить `turn_id`, policy/configuration binding, workspace/snapshot binding та впорядкований список фактично доставлених inputs.

| Поле input entry | Контракт |
|---|---|
| `input_id`, `origin` | Turn-local ID; походження `task_artifact`, `review_baseline` або `review_diff` |
| `artifact_id`, `content_hash` | Авторизований sealed artifact і hash його bytes або tree manifest; provider не обирає hash |
| `content_type`, `size_bytes` | Фактичний тип і повний обсяг input; без прихованого truncation |
| `delivery` | `inline` або `read_only_path` |
| `binding` | Для inline — ID секції в context envelope; для path — broker-generated readable file/tree location, не довільний caller path |
| `access_enforcement` | Для materialized path — `enforced` із reference на tested profile; для inline — `not_applicable` |
| `lifetime` | Binding чинний лише для цього turn до confirmed managed quiescence; bytes, уже передані моделі, не відкликаються з native history |

Усі `task.artifact_refs` required у MVP; implicit optional inputs немає. Будь-яка недоставлена required entry забороняє dispatch. Manifest засвідчує delivery binding, **не** факт прочитання/розуміння input моделлю. Спостережуване читання tools може бути додатковим evidence, але його не можна вигадувати з одного manifest.

### 5.7. Artifact references та pins

Reference означає provenance або можливість читання, доки content retained. `ArtifactPin` означає заборону cleanup для конкретного root/reason. Історичний reference у terminal turn або native transcript сам по собі не pin-ить усі bytes назавжди. Pin roots і правила звільнення визначено в §15.3.

Pins та admission/cleanup state changes MUST координуватися через одну durable metadata boundary. Artifact, який уже переведено cleanup-ом у `expired`, не можна прийняти як required input. З іншого боку, cleanup не може видалити artifact після того, як accepted turn атомарно його pin-нув.

---

## 6. Lifecycle sessions і turns

### 6.1. Session states

| State | Значення | Чи можна `send`? |
|---|---|---|
| `PROVISIONING` | Durable session уже створено; workspace/baseline ще готуються | Ні: `SESSION_NOT_READY` |
| `IDLE` | Немає незавершеного turn; native context може ще не існувати | Так, після preflight, якщо немає pending close intent |
| `ACTIVE` | Є прийнятий, запущений, cancelling або finalizing turn | Ні: `SESSION_BUSY` |
| `BLOCKED` | Є unresolved execution, втрачений context, policy/compatibility problem | Ні: конкретна причина блокування |
| `CLOSED` | Session явно закрито; registry та history збережено | Ні: `SESSION_CLOSED` |

`spawn` створює durable `PROVISIONING` session **без inference**; після підготовки workspace/baseline вона переходить в `IDLE`. Native conversation може створитися лише на першому `send`. Назва `spawn` означає створення logical session, а не обов’язковий негайний запуск CLI.

Невдале provisioning переводить session у `BLOCKED` із provisioning error та evidence cleanup state; повторний spawn з тим самим key не створює іншу session. Operator може завершити recovery або зафіксувати partial workspace як retained і завершити provisioning intent без видалення файлів. Після цього можливе guarded close за §6.4; відновлювати native context для close не потрібно.

Після успішного turn session знову `IDLE`. Помилка одного turn не завжди руйнує native context: adapter повертає окремий `context_status`. `UNKNOWN` або непридатний context блокують session.

### 6.2. Turn states

Оглядова діаграма, **не** повний перелік transitions; нормативна таблиця — §6.5:

```text
ACCEPTED → STARTING → RUNNING → FINALIZING → SUCCEEDED / FAILED
    └─────────┴─────────┴→ CANCELLING → FINALIZING → CANCELLED / TIMED_OUT

Pre-dispatch failure → FINALIZING → FAILED
Невизначений execution або quiescence → UNKNOWN
UNKNOWN → FINALIZING → встановлений outcome або operator-approved ABANDONED
```

Terminal states: `SUCCEEDED`, `FAILED`, `CANCELLED`, `TIMED_OUT`, `ABANDONED`. Кожен terminal commit проходить через `FINALIZING`; пропуск стану не дозволяє обійти evidence чи resource-release checks.

`UNKNOWN` — **не terminal state**. Він займає session slot та утримує reservations/quarantine, доки execution і disposition ресурсів не узгоджено за §14.5. Втрата heartbeat не є підтвердженням зупинки.

`SUCCEEDED` означає: adapter підтвердив завершення протокольного turn, managed quiescence підтверджена, artifacts sealed, required input delivery та обов’язкові broker checks пройдені. Це **не** означає, що реалізація правильна, review пройдено або всі тести достовірно успішні. `quality_status` спочатку завжди `unreviewed`.

`ABANDONED` означає: виконання більше не активне, але його повний outcome не вдалося встановити. Це не еквівалент `never_started`. Потрібні operator reconciliation, доступне partial evidence та явне рішення про workspace/session recovery; автоматичного retry немає.

У `FINALIZING` зберігається окремий `terminal_candidate` з evidence його походження. Для відомого execution outcome порушення mandatory scope/coverage/output/evidence checks дає `FAILED`, навіть якщо candidate був `SUCCEEDED`, `CANCELLED` чи `TIMED_OUT`; первісні `native_outcome` і `termination_reason` не стираються. Для невстановленого outcome після operator-confirmed quiescence використовується `ABANDONED` із явними evidence gaps, не вигаданий `FAILED` або `SUCCEEDED`. Якщо навіть мінімальний terminal record неможливо durable commit-нути, turn не оголошується terminal і release не відбувається.

### 6.3. Waiting, approvals і interactive input

Завершення поточного task означає `IDLE` session, а не очікування відповіді користувача. MVP не підтримує довільне інтерактивне продовження active turn.

Якщо CLI потребує approval, trust decision, login або іншого input, adapter сигналізує `INTERACTION_REQUIRED`, намагається контрольовано завершити execution і зберігає evidence. Це не auto-approve і не успішне виконання. У разі непідтвердженого shutdown turn стає `UNKNOWN`.

Operator виконує потрібний native onboarding поза broker, після чого coordinator явно вирішує, чи надсилати новий task. Account login не передається model-у як task.

### 6.4. Cancel, process eviction і close

`agent_turn_cancel` ідемпотентно запитує cancellation; acknowledgement не доводить, що process tree вже зупинилося. Terminal `CANCELLED` дозволений лише після confirmed managed quiescence та finalization доступного partial result. Cancel, прийнятий до дозволу на task dispatch, забороняє передавання task у native execution: не потрібно запускати inference лише для того, щоб його скасувати (§14.6).

Idle process MAY бути evicted для звільнення RAM. Native conversation ref і logical session зберігаються. Adapter повинен продовжувати conversation після нового process launch; інакше він не проходить MVP continuity requirement.

**Guarded close.** `agent_session_stop` може явно закрити `IDLE` або `BLOCKED` session, зокрема з `context_status=missing`, якщо одночасно виконано всі умови:

1. Немає жодного незавершеного turn, включно з `UNKNOWN`, `ACCEPTED`, `CANCELLING` і `FINALIZING`.
2. Managed execution цієї session quiescent; немає невстановленого owned process/tool activity. Idle runtime, якщо існує, має бути контрольовано зупинений до фінального `CLOSED` commit.
3. Provisioning та інші session-owned mutating intents узгоджені: завершені, безпечно зупинені або partial outputs позначені retained. Немає pending writer/provisioning action, яка може ще змінювати workspace. Видаляти retained workspace для close не потрібно.
4. Caller має чинне право close; session state/revision та intent перевірено атомарно, щоб concurrent `send` не міг бути прийнятий після close intent.

Прийняття close створює durable idempotent intent і `close_state=pending`; подальший `send` повертає `SESSION_CLOSING`. Зупинка idle runtime може завершуватися поза MCP request. Response/status показують `close_state=none|pending|completed|failed` та current session state; acknowledgement `pending` не є підтвердженням `CLOSED`.

Після підтвердження guards daemon атомарно встановлює `CLOSED`, `close_state=completed`, звільняє **logical-session capacity slot** і session-only pins за §15.3. Records, native history та workspace contents не видаляються. Невдалий або невизначений shutdown дає `BLOCKED`, `close_state=failed` із evidence; cap залишається зайнятим. Після reconciliation для нового close attempt потрібен новий key; replay failed close не повторює side effects.

При незавершеному звичайному turn stop повертає `ACTIVE_TURN`; при `UNKNOWN` — `EXECUTION_UNKNOWN`. При незавершеному provisioning — `SESSION_NOT_READY`; при unresolved session-owned side effects — `SESSION_BLOCKED` з деталями guard. `PROVISIONING` спочатку має пройти recovery до визначеного стану. Другий close з іншим key під час pending close дає `SESSION_CLOSING`; той самий key повертає existing close operation. Уже `CLOSED` session повертає існуючий closed state без повторної зупинки.

**Close MUST NOT** встановлювати outcome `UNKNOWN`, знімати workspace quarantine, звільняти чужі reservations, виконувати reset/clean/delete, означати rollback або вимагати відновлення втраченої conversation. Для unresolved execution спочатку потрібний §14.5. Reopen та видалення native history залишаються поза MCP API MVP.

### 6.5. Нормативні transition tables та resource release

Усі state changes мають expected record revision, перевірені guards і durable event. Невказаний перехід заборонений. Повторне спостереження тієї самої події може оновлювати дозволені diagnostics, але не повторює release або side effect. `∅` означає відсутність record.

#### 6.5.1. Session transitions

| From | Trigger | Guards | Durable effects | To |
|---|---|---|---|---|
| `∅` | Прийнятий spawn | ACL, policy, session cap, idempotency | Session, provisioning intent, cap reservation | `PROVISIONING` |
| `PROVISIONING` | Provisioning завершено | Workspace готовий; required initial snapshot sealed; review slot може бути ще порожнім | Initial binding/pins, завершення intent | `IDLE` |
| `PROVISIONING` | Provisioning failure | Зафіксовано known/unknown side effects | Error, partial-workspace disposition, необхідні reservations/quarantine збережено | `BLOCKED` |
| `IDLE` | Accepted send | §7.2; немає pending close | Turn, active turn ref, leases/capacity/input pins | `ACTIVE` |
| `IDLE` | Виявлено непридатний context/profile або unresolved idle runtime | Evidence блокування | Block reason; потрібний захист ресурсів | `BLOCKED` |
| `ACTIVE` | Turn стає `UNKNOWN` | Execution outcome або managed quiescence не встановлені | Active turn збережено; quarantine/reservations | `BLOCKED` |
| `ACTIVE` | Terminal turn committed | §6.5.3; context usable, workspace ready, немає unresolved issue | Result, release/transfer ресурсів, latest anchors | `IDLE` |
| `ACTIVE` | Terminal turn committed, але reuse unsafe | §6.5.3; context/workspace/policy не готові або candidate `ABANDONED` | Result, block reason, необхідний recovery protection | `BLOCKED` |
| `BLOCKED` | `UNKNOWN` turn переходить у `FINALIZING` | Reconciliation з підтвердженою quiescence | Той самий active turn; жодного нового dispatch | `ACTIVE` |
| `BLOCKED` | Operator recovery без незавершеного turn | Context usable або достовірно ще не створений; baseline/policy готові; intents reconciled; close не pending | Explicit recovery decision, baseline/pin update | `IDLE` |
| `IDLE` або `BLOCKED` | Close intent прийнято | §6.4 | `close_state=pending`, заборона нового send; cap ще зайнятий | Стан не змінюється до close outcome |
| `IDLE` або `BLOCKED` | Close завершено | §6.4; idle runtime shutdown підтверджено | Close result, cap release, session-pin release | `CLOSED` |
| `IDLE` або `BLOCKED` | Close shutdown failed/unknown | Intent існує; guards completion не підтверджені | `close_state=failed`, error/evidence; без cap release | `BLOCKED` |
| `CLOSED` | Повторний stop/read | Чинна авторизація | Existing state; немає execution effects | `CLOSED` |

`context usable` означає `available`, або `not_started`, коли evidence достовірно виключає створення/dispatch попередньої conversation. `unverified` і `missing` не дозволяють автоматичний reuse. `workspace ready` означає доступний сумісний baseline, завершені source/input checks, відсутність unresolved policy issue та потрібного quarantine. Scope/coverage/evidence failure може залишити session blocked навіть за збереженого native context; snapshot refresh сам по собі не є recovery approval.

#### 6.5.2. Turn transitions

| From | Trigger | Guards | Durable effects | To |
|---|---|---|---|---|
| `∅` | Final admission | §7.2 | Turn + idempotency record + reservations + pins | `ACCEPTED` |
| `ACCEPTED` | Daemon починає startup | Readiness/ownership чинні; немає earlier cancel | Startup intent, state revision; task ще не вважається dispatched | `STARTING` |
| `ACCEPTED` | Відомий pre-start failure | Task достовірно не dispatched; managed quiescence | Candidate `FAILED`, `execution_started=false`, partial evidence | `FINALIZING` |
| `ACCEPTED`, `STARTING`, `RUNNING` | Cancel або deadline | Немає вже встановленого final outcome; intent серіалізовано з dispatch permission | Cancellation reason/intent; запуск termination лише за потреби | `CANCELLING` |
| `STARTING` | Task dispatch підтверджено native evidence | Required inputs/baseline/policy перевірені; launch journal існує | Runtime/native refs, `execution_started=true` | `RUNNING` |
| `STARTING` | Startup failure або швидкий native completion | Outcome відомий, managed quiescence confirmed; для `execution_started=false` є доказ no dispatch | Candidate/reason, доступне evidence; проміжний `RUNNING` не вигадується | `FINALIZING` |
| `RUNNING` | Встановлено native outcome | Managed quiescence confirmed | Native outcome, candidate, final capture intent | `FINALIZING` |
| `CANCELLING` | Shutdown/no-dispatch/completion підтверджено | Managed quiescence; outcome/reason відомі | Candidate за §14.6, partial result; без rollback | `FINALIZING` |
| Будь-який nonterminal, крім `UNKNOWN` | Execution/quiescence невизначені | Недостатньо достовірного evidence | `EXECUTION_UNKNOWN`, session block, утримання ресурсів/quarantine | `UNKNOWN` |
| `UNKNOWN` | Reconciliation встановила outcome | Quiescence confirmed, authoritative outcome evidence | Recovery decision і candidate; без нового prompt | `FINALIZING` |
| `UNKNOWN` | Operator обирає abandon | Quiescence confirmed; outcome все ще невідомий; workspace inspected, baseline captured або явний capture failure | Candidate `ABANDONED`, recovery gaps, partial artifacts | `FINALIZING` |
| `FINALIZING` | Mandatory evidence/checks готові або їхній failure достовірно зафіксовано | §6.2 та §6.5.3; quiescence confirmed; мінімальний result durable | Один terminal result і один узгоджений release/transfer | Один із п’яти terminal states |
| Будь-який terminal | Late cancel/event/replay | Чинна ACL; incarnation/revision checks | Existing outcome; дозволені лише окремі audit diagnostics | Той самий terminal |

Відомий storage/capture failure без невизначеного execution **не** є підставою для `UNKNOWN`: він залишається finalization failure. Після crash відновлення вже відомого completion може продовжити `FINALIZING` без inference. Коли неможливо durable записати outcome, read APIs не вигадують terminal state з пам’яті процесу.

#### 6.5.3. Єдиний terminal commit / release protocol

До terminal commit daemon MUST підтвердити managed quiescence, закінчити або явно fail-нути final capture/checks, sealed input/result provenance та підготувати terminal capsule. Часткові artifacts не видаються за full snapshots. `execution_started=false` звільняє від inference, але не від перевірки незавершених startup/materialization side effects.

В одній metadata transaction записуються terminal state/result, прибирається active turn ref, звільняються turn/account/global capacity, releases або transfers leases/pins і встановлюється наступний session state. Операції поза DB, зокрема видалення тимчасових input views, мають окремі journaled intents; невидалені copies залишаються облікованими у storage. Повторний callback/recovery не може вдруге звільнити reservation.

Workspace lease звільняється лише коли жодне owned execution/capture не може ще писати. Якщо потрібна подальша operator перевірка, lease/protection атомарно переноситься в окремий workspace quarantine record; terminal turn не означає автоматичне зняття quarantine. `UNKNOWN` до узгодженого terminal outcome не звільняє turn slot і reservations. Logical-session cap звільняється тільки при `CLOSED`, не при terminal turn.

---

## 7. Task contract, admission та idempotency

### 7.1. Task contract

Кожен `send` містить зрозумілий worker-у `goal`, `acceptance_criteria`, потрібний task-specific context, references на наявні артефакти та workspace precondition. `relevant_paths` і рекомендовані `checks` необов’язкові.

`checks` — інструкції для агента, **не** команди, які broker автоматично запускає. Порожній goal заборонено. Надмірний task/context відхиляється до inference із зазначенням size limit. `artifact_refs` — впорядкований масив унікальних artifact IDs; дублікати є `INVALID_REQUEST`. Усі entries required; broker не викидає недоступну entry з task.

Для звичайного write/read turn потрібен `expected_snapshot_id`, отриманий із попереднього result або initial workspace baseline. Для review turn потрібна пара `baseline_snapshot_id` / `target_snapshot_id`. Snapshots повинні бути sealed, доступні owner-у, належати тому самому project та мати однаковий coverage binding за §9.5. Довільний ID не дає доступу до іншого project.

Перед native execution broker додає детермінований context envelope: session/turn IDs, роль, workspace binding, фактичний target snapshot, зміни від попереднього turn, restrictions, input manifest bindings і вимогу перечитати змінені файли. Він не пересилає весь transcript і не вдає, що стара пам’ять агента автоматично відповідає поточному коду.

### 7.1.1. Artifact input delivery перед dispatch

**Resolve та admission.** Для кожного required artifact daemon перевіряє чинний project/owner ACL, `SEALED` state, retained content, content hash, тип, size limits і можливість доставки під обраним policy/profile. Review baseline/diff inputs проходять ті самі правила; target source матеріалізується в `review_slot`. При final admission artifact/snapshot pins і потрібний storage headroom резервуються атомарно з turn (§7.2, §15.3).

**Broker-derived inputs.** Diff для review може ще не існувати під час admission. У цьому випадку acceptance pin-ить sealed baseline/target і резервує storage для derived diff; daemon створює його після acceptance за journaled preparation intent. Новий diff artifact публікується та pin-иться для того самого turn, проходить type/size/hash/delivery checks і MUST бути sealed до input manifest та dispatch. Це не дозволяє пропустити або відкласти доставку required task artifacts. Failure derivation дає pre-dispatch failure; жодного native task із відсутнім diff.

**Delivery.** Broker детерміновано вибирає один канал, який допускає verified profile:

- `inline`: повний невеликий UTF-8/structured-text artifact у чітко позначеній data section context envelope, з ID/hash. До всіх inline inputs застосовується сумарний byte cap. Це дані, не інструкції policy.
- `read_only_path`: повний artifact materialized як файл або admitted snapshot tree у broker-managed per-turn input area **поза writable source tree**. Envelope містить точний readable location, ID/hash і тип. Broker надає лише потрібний read grant; write denial має бути `enforced` для цього view.

Default selection: невеликий підтриманий текст може бути inline у межах budget; решта підтриманих inputs — read-only materialization. Профіль може вимагати лише materialization. Якщо жоден дозволений канал не вміщує/не підтримує artifact, запит fail-иться явно; truncation, summary substitution, перекодування binary у вигаданий текст або пропуск input заборонені. Текстові reports/patches і підтримані source snapshot trees входять у MVP; довільний binary format потребує явно tested input profile, інакше `INPUT_UNSUPPORTED`.

**Передача adapter-у.** Після materialization broker повторно перевіряє binding, hashes, доступність під effective restrictions і відсутність source-path collisions. Він seals `TurnInputManifest`, persist-ить його ID/hash і включає у launch intent до task dispatch. Adapter не отримує всієї artifact directory, credentials або права викликати broker MCP. Generated locations визначає broker, не вміст artifact і не caller.

**Lifetime.** Views immutable протягом turn; їх не можна refresh-ити до confirmed quiescence. Кожен наступний turn має нові bindings; старі paths не оголошуються актуальними inputs лише тому, що вони є у native history. Grants прибираються після quiescence, а deletion/staging cleanup журналюються. Вже передані inline bytes/прочитаний content можуть залишатися в native conversation; broker не обіцяє їх «відкликати» з пам’яті моделі.

**Errors.** Недозволений або невідомий caller-у ID повертає `UNAUTHORIZED` без розкриття існування чужого artifact; дозволений неготовий — `ARTIFACT_NOT_READY`, expired — `ARTIFACT_EXPIRED`, unsupported input — `INPUT_UNSUPPORTED`, завеликий — `INPUT_LIMIT`, hash mismatch — `ARTIFACT_CORRUPT`. Доставка, що не вдалася після acceptance, дає turn `FAILED` із `INPUT_DELIVERY_FAILED` або конкретнішою причиною та `execution_started=false`, лише якщо journal підтверджує no dispatch. Жоден required input failure не дозволяє почати inference з неповним task.

### 7.2. Прийняття turn

**Одна точка атомарності admission.** Authoritative idempotency lookup, canonical-payload comparison та остаточне рішення «replay / conflict / reject / accept» MUST бути серіалізовані з session/resource checks і записом operation. Попередні reads/preflight — лише оптимізація, не остаточне рішення.

Послідовність:

1. Перевірити чинну caller identity/authorization, resolved project/owner binding, request schema і transport/input size. Обчислити canonical request hash. Відкликаний доступ забороняє навіть replay раніше успішного request.
2. MAY виконати fast lookup committed idempotency record. За однакового payload повернути existing operation, за іншого — `IDEMPOTENCY_CONFLICT`; не повторювати mutable execution checks для existing operation. Відсутність record на цьому кроці нічого не резервує.
3. Без inference підготувати CLI/policy/workspace/coverage/input preflight. Потенційно дорогі filesystem/hash checks виконуються поза довгою DB transaction. Їхні observations мають version/identity binding; errors на цьому етапі є candidates до остаточного admission decision, якщо equivalent operation могла бути прийнята конкурентно.
4. В authoritative serialized metadata boundary **знову** перевірити поточну authorization/config revision та idempotency record. Existing same-payload operation повертається раніше за `SESSION_BUSY`, `SESSION_CLOSING`, capacity або інший mutable-state rejection. Existing different-payload operation дає `IDEMPOTENCY_CONFLICT`.
5. Лише якщо record немає, у тій самій boundary перевірити daemon readiness, session revision/state/close intent, owner, чинний policy/capability binding, resource availability і retained/sealed artifact state. Неактуальні preflight observations перевірити повторно без dispatch; вони не можуть бути підставою для acceptance з іншою policy. Остаточне rejection не створює accepted turn або side effects.
6. Якщо checks пройдені, **в одній transaction** створити `turn_id`, idempotency operation/hash, turn/task bindings, session slot, workspace lease, account/global capacity, required snapshot/artifact pins та storage reservation; зафіксувати `ACCEPTED`. Повернути `turn_id`; daemon працює незалежно від MCP connection.
7. У `STARTING` перед side effects повторно перевірити workspace під lease, зняти independent source inventory, підготувати input delivery/review slot і перевірити latest cancel/policy state. До process launch записати launch intent з known input references; до фактичного task dispatch sealed input manifest та dispatch permission MUST бути durable. Runtime/native refs persist-яться якнайшвидше. Candidate preflight success не гарантує, що filesystem не змінився до цього кроку.

У DB MUST бути unique constraint на idempotency namespace і constraints, що захищають active-turn/resource invariants. Конфлікт унікальності key розв’язується читанням existing operation і порівнянням canonical payload; це **не** generic DB error або `SESSION_BUSY`. Нова спроба короткої metadata transaction без зовнішніх side effects не є retry native task. Storage outage не видається за successful replay без прочитаного durable record.

Після final decision equivalent concurrent requests converge до одного ID. Якщо request справді rejected раніше за acceptance іншого request у серіалізованому порядку, він не обіцяє майбутнього успіху. Але жоден mutable rejection не може приховати equivalent operation, яка вже committed до його authoritative decision point.

У MVP немає необмеженої черги. Для **різних** request keys зайнята session дає `SESSION_BUSY`, pending close — `SESSION_CLOSING`; capacity/workspace — `RESOURCE_BUSY` / `WORKSPACE_BUSY`, без прийняття turn. Coordinator вирішує, коли повторити запит.

Якщо startup/pre-dispatch operations неуспішні, finalization дає `FAILED` із `execution_started=false` лише за достовірного no-dispatch evidence. Невизначений dispatch проходить `UNKNOWN`, а не «безпечний retry». Replay вже прийнятого turn не повторює materialization, launch чи inference самостійно.

### 7.3. Idempotency semantics

Ключовий namespace: `(project_id, owner_coordinator_id, operation_name, idempotency_key)`.

| Ситуація | Поведінка |
|---|---|
| Той самий key і той самий canonical payload, зокрема concurrent requests | Той самий durable operation/session/turn або acknowledgement, без повторного effect; replay не маскується mutable-state error |
| Той самий key, інший payload | `IDEMPOTENCY_CONFLICT` |
| Запит відхилено до acceptance через зайнятий resource | Turn не створюється; той самий key можна використати при повторній спробі |
| Response загубився після acceptance | Повторний запит повертає вже наявний ID та актуальний стан |
| Старий turn завершився помилкою | Той самий key повертає старий failed turn, а не запускає retry |
| Coordinator свідомо запускає новий attempt | Новий key; MAY вказати `retry_of_turn_id` для lineage |

Canonical payload включає session/project, task, ordered artifact/snapshot bindings і requested execution options; transport request ID та timestamps у hash не входять. Зміна змісту task — інший request. Canonicalization versioned: object keys нормалізуються, defaults розв’язуються за API schema, порядок arrays і точні bytes task strings зберігаються. Generated paths, effective delivery mode, input manifest ID та інші результати preflight у request hash не додаються; вони фіксуються в accepted operation. Artifact content immutable, тому той самий ID не може позначати нові bytes.

Ці правила стосуються всіх mutating tools, не лише `send`: `spawn`, snapshot capture, cancel і stop мають authoritative lookup до власних final mutable checks. Authorization перевіряється щоразу. Після зафіксованого rejection до acceptance caller може повторити той самий key; після acceptance зміна key означає новий explicit attempt, а не transparent transport recovery.

Idempotency records зберігаються не менше життєвого циклу відповідних records. Автоматично видаляти key, залишаючи живу session, заборонено. Operator purge створює явну межу retention; після purge broker більше не обіцяє дедуплікацію старих запитів.

`spawn` також idempotent: session ID і provisioning intent записуються до створення worktree. Повторний запит не створює другий workspace. Незавершене provisioning відновлюється за journal; caller може перевірити session status.

### 7.4. Немає application-level exactly-once

Deduplication гарантує відсутність повторного **прийняття** одного broker request. Вона не гарантує exactly-once команд, записів у файли, remote API calls або інших side effects, які виконує CLI.

MVP не дозволяє broker-у сліпо повторювати native prompt після network error чи невизначеного launch. Транспортне перепідключення без нового turn дозволено тільки за перевіреною семантикою adapter-а.

---

## 8. Workspace, access і locks

### 8.1. Незалежні параметри

| Вісь | Значення MVP | Значення |
|---|---|---|
| `workspace.mode` | `current`, `worktree`, `review_slot` | Розміщення робочого коду |
| `access` | `read_only`, `workspace_write` | Дозволений тип змін |
| `sandbox.profile` | Ідентифікатор затвердженого профілю | Реальний механізм обмеження, не просто назва режиму |
| `tool_policy` | Затверджений allowlist/profile | Shell, file tools, MCP, native delegation |
| `tool_network_policy` | Затверджений профіль | Мережеві дії інструментів агента |
| `write_scope` | Відносні source path prefixes | Дозволені source changes, включно зі створенням майбутніх untracked files |
| `non_source_write_scope` | Явні output/cache prefixes, default `[]` | Дозволені non-source outputs; не можуть приховувати source changes |

У MVP `role=reviewer` потребує `review_slot`, `read_only` і read/search-only tool profile. Такий reviewer сам не запускає тести. Запуск тестів worker-ом можливий, але його evidence не стає незалежною перевіркою.

Звичайний researcher може використовувати `current + read_only`. Worker — `current/worktree + workspace_write`. Вибір `sandbox.profile` не змінює workspace topology.

### 8.2. Current checkout

Перед першим turn broker фіксує initial snapshot, HEAD/index metadata і доступний dirty-state inventory. Baseline **не дорівнює HEAD**, якщо вже є незакомічені зміни. Initial snapshot повертається в session status.

Різниця baseline → final snapshot — це `observed_workspace_delta` за час turn, не автоматично «всі зміни цього агента» і не весь `git diff HEAD`. Початкові зміни користувача не приписуються worker-у.

Dirty state сам по собі не є забороною. Але зміна workspace після snapshot, несумісна з precondition, повертає `WORKSPACE_CHANGED`; автоматичний stash/reset/rebase не виконується.

### 8.3. Worktree

Broker створює окремий managed worktree від явного `base_commit`. У MVP це detached worktree; створення branch і commit не потрібне для result. Незакомічені зміни current checkout не переносяться в нього автоматично; spawn response явно показує цей факт.

Git metadata operations broker-а серіалізуються repo-level lock. Workspace write locks не означають незалежність спільного Git metadata. Worker profile за замовчуванням не дозволяє операції commit/reset/clean/stash, зміну refs чи index; broker додатково перевіряє спостережувані HEAD/index changes. Нові source files MUST потрапляти у snapshots без `git add`; зміна index не є вимогою capture.

Після close worktree зберігається. Operator може видалити чистий worktree окремою локальною командою; dirty worktree потребує explicit acknowledgement після збереження artifacts. Broker не має automatic cleanup із `--force`.

### 8.4. Reader/writer leases

Для broker-managed доступу діє reader/writer policy: кілька read-only turns можуть одночасно читати один current workspace; writer потребує exclusive lease. `FINALIZING` і snapshot capture утримують lease до завершення evidence capture.

Паралельні writer-и отримують різні workspaces. Path scopes не скасовують exclusive writer rule. Workspace identity canonicalized; два aliases одного шляху не створюють два незалежні locks.

Leases містять owner turn, runtime incarnation і revision. Вони не зникають лише через timeout. Якщо daemon не може довести завершення managed execution, workspace переходить у quarantine і новий writer не допускається.

### 8.5. Path scopes та реальне enforcement

MVP path scopes — нормалізовані відносні prefixes, без довільних glob expressions. Prefix порівнюється за path components: `src/parser` не включає `src/parser-old`. `..`, absolute paths, escaping symlinks та broker-private paths відхиляються. `write_scope`, `non_source_write_scope` і заборонені paths policy перевіряються на суперечності до запуску; requester не може перевизначити classification текстом task.

Session/status/result MUST показувати enforcement для кожного обмеження: `enforced`, `postcheck_only`, `advisory`, `unknown`. Prompt «не змінюй файл» не є enforcement.

Read-only source для reviewer-а потребує перевіреного enforcement; лише postcheck недостатньо. Для write scopes user policy MAY дозволити `postcheck_only`, але це явно означає виявлення порушень після запису, а не їх запобігання. Виявлене порушення дає failed turn із evidence; broker не намагається сам відкотити чужі файли.

### 8.6. Зовнішні writers і межі гарантії

Locks координують broker-owned учасників. Вони не забороняють оператору, IDE чи сторонньому process змінювати файли поза broker.

Broker SHOULD перевіряти pre/post fingerprints, HEAD/index та зміни під час snapshot capture. Спостережуваний conflict блокує прийняття результату. Відсутність detected conflict не доводить, що зовнішніх записів не було. Result позначає attribution як `workspace_delta`, а isolation — як broker-coordinated, не глобально atomic.

Для паралельної ручної роботи рекомендуються окремі worktree. Без зовнішньої OS isolation MVP не обіцяє захист від ворожого same-user process.

### 8.7. Source classification та independent inventory

**Classification є частиною versioned policy/coverage contract**, а не висновком агента після роботи. Для кожного дозволеного writable path визначено одну категорію:

| Категорія | Правило |
|---|---|
| `source` | `write_scope`; усі observed created/modified source files мають бути в final snapshot; видалення має бути представлене baseline → final delta |
| `non_source_output` | `non_source_write_scope`; build outputs, caches та runtime outputs, які явно дозволені policy; не включаються в source snapshot, але exclusions/observed changes видимі |
| `protected_or_undeclared` | Broker inputs/state, Git metadata поза дозволеними broker operations, чужі paths, незадекларовані writes; observed violation fail-ить turn |

Source і non-source writable sets MUST бути несуперечливими. Неоднозначні/overlapping prefixes відхиляються, а не вирішуються на користь exclusion. Tracked source file не може бути виключений як generated output тільки через directory name чи `.gitignore`. Для простого MVP profile слід використовувати явні source та output prefixes без overlap.

До inference broker MUST перевірити, що coverage contract охоплює **весь дозволений source write set**, включно з файлами, які ще не існують. Наприклад, дозвіл створювати файли у `src/parser` потребує prefix-based source coverage цієї директорії, не лише inventory наявних `.c` файлів. Суперечність дозволеного write set і capture rules дає `SNAPSHOT_COVERAGE_MISMATCH` до dispatch. Policy забороняє включати secret — це причина failure, а не дозвіл таємно викинути source file.

Під workspace lease broker знімає **pre-turn і post-turn inventory, незалежні від selection уже наявних snapshot manifests**. Inventory охоплює підтримувані source entries, усі writable source prefixes і directory entries, потрібні для виявлення нових/видалених/перейменованих paths. Не можна отримати post-turn inventory лише з `git diff`, Git index або diff manifests. `.gitignore` не приховує новий файл у writable source prefix. Дозволені non-source areas можна inventory-ити окремо з bounded metadata; broker-private/Git areas контролюються своїми guards, а не включенням credentials у snapshot.

Кожен observed created/modified source entry MUST бути у final manifest з фактичним content hash/type/mode. Для observed deletion перевіряються prior source entry та його відсутність у final; rename можна представити як delete+add. Якщо inventory бачить source change, який capture не представляє, finalization fail-иться з `SNAPSHOT_COVERAGE_MISMATCH`; result містить affected paths і причину без forbidden file content. Заборонений write поза policy — `SCOPE_VIOLATION`. Дозволений generated output не є source regression лише через появу нового файла.

Цей inventory не доводить авторство змін, не гарантує виявлення створених і видалених між перевірками transient files та не долає hostile external writers. У metadata фіксуються inventory coverage/limits. Якщо mandatory inventory неможливо завершити через size, unreadable або unsupported source, його не можна позначити `complete` і повертати `SUCCEEDED`.

---

## 9. Snapshot-based review

### 9.1. Що фіксується

Snapshot включає всі підтримувані tracked source files та source paths, дозволені versioned coverage profile. Untracked source selection задається prefixes і охоплює **майбутні** нові файли; Git staging не потрібний. При writer turn profile MUST включати весь `write_scope` за §8.7. `git ls-files` або список existing files initial snapshot не є повним selector-ом final source set.

Manifest містить relative paths, entry type, content hash, executable bit де підтримується, coverage profile ID/version/contract hash, source workspace, capture timestamps, inventory reference і Git provenance. Зміни source set через create/delete не змінюють coverage contract: той самий selector закономірно повертає інший manifest.

Default exclusions для nontracked data: `.git`, explicitly classified build caches/dependencies, broker state та credentials. Exclusions і non-source classification MUST бути видимі та несуперечливі з writable source set. Не можна використовувати exclusion, щоб замаскувати новий source module/test, tracked code або scope violation. Якщо policy забороняє включити tracked secret або snapshot не представляє повністю заявлений source set, capture завершується помилкою, не «повним snapshot» без частини коду.

Для MVP regular files і directories підтримуються; submodules, LFS content без materialization, special files та symlinks без окремого tested safe profile відхиляються як `SNAPSHOT_UNSUPPORTED`. Не можна підміняти реальний source file unresolved pointer-ом без metadata. Source/profile несумісність дає `SNAPSHOT_COVERAGE_MISMATCH`; unreadable/failed capture — явний evidence error.

Size limits перевіряються до inference, коли це можливо. Якщо source set виріс понад cap під час turn, finalization failure не дозволяє обрізати snapshot. Review snapshot не зобов’язаний містити встановлені dependencies, секрети для тестів чи повне build environment. Ці обмеження є частиною review context, не дозволом запускати reviewer-ом тести в неповному environment.

### 9.2. Capture та sealing

Broker захоплює потрібний workspace lease, виконує independent inventory за §8.7, копіює admitted source set у staging і звіряє manifest із inventory. Для final writer snapshot він додатково перевіряє, що observed source delta повністю представлено. Capture не покладається лише на файли, відібрані initial manifest.

Після перевірки hashes/stability broker seals manifest і публікує immutable artifact references. Виявлена зміна source set під час capture дає `SNAPSHOT_UNSTABLE`; непредставлений observed source change — `SNAPSHOT_COVERAGE_MISMATCH`. Content-addressed storage за §14.1 не скасовує читання/перевірку фактичного source і не дозволяє довіряти старому hash лише через незмінний pathname.

У metadata зазначено `capture_consistency=broker_exclusive` — відсутність competing broker writer, а не заборона concurrent broker readers — inventory/coverage status та факт, що external writers виключаються лише домовленістю. Immutable означає незмінність **збереженого artifact content**, не доказ snapshot усього checkout в єдину фізичну мить.

Partial snapshot не видається за sealed snapshot. Невдале evidence capture після execution не дозволяє `SUCCEEDED`: зберігаються partial result, inventory diagnostics, `final_snapshot_id=null` коли валідного snapshot немає, і конкретна причина. Partial artifact не можна використовувати як `expected_snapshot_id` або review target.

Матеріалізовані views не повинні мати writable inode alias на immutable blob storage. Hardlink із file view, який runtime здатний змінити, у source blob заборонений. Copies або інший tested ізольований materialization mechanism обирає implementation; policy-specific read-only enforcement перевіряється окремо.

### 9.3. Stable review slot

Reviewer session має окремий broker-managed `review_slot` зі стабільним cwd. Перед кожним review turn broker, коли попереднє managed execution quiescent, матеріалізує туди **target snapshot** і надає baseline/diff через input-delivery contract §7.1.1. Baseline tree та diff мають окремі manifest bindings, доступні тим самим read/search-only tools, без broker MCP чи shell. Target materialization прибирає stale files попереднього snapshot тільки всередині broker-owned review slot; це не cleanup worker checkout.

Review slot — не moving worker checkout і не власний source of truth. Broker може оновити його лише **між** turns. Immutable snapshots при цьому не змінюються. Native conversation reviewer-а залишається тією самою; prompt явно повідомляє, які snapshots замінили попередню версію коду.

Така модель потребує окремого adapter test: native resume після broker-managed заміни source snapshot у тому самому cwd. Якщо provider не підтримує її коректно, це blocking issue для цього adapter-а, а не підстава робити fresh reviewer непомітно.

### 9.4. Findings та review binding

Reviewer передає findings, які broker зберігає як agent-reported content. Broker сам додає фактичні `reviewed_baseline_snapshot_id`, `reviewed_target_snapshot_id`, reviewer session/turn і references на diff.

Рекомендована форма finding: stable finding ID, severity, path/line або source reference, опис, обґрунтування та suggested validation. Broker не вигадує severity і не вирішує, чи finding закрито.

Після fix target змінюється з S1 на S2. Reviewer отримує S1 → S2 для перевірки виправлень і за потреби початковий baseline → S2 для загального review. Coordinator обирає обсяг перевірки явно.

### 9.5. Сумісність coverage snapshots

Для MVP `expected_snapshot_id` має відповідати активному coverage contract workspace/session. Review baseline і target MUST мати однакові `coverage_profile_id`, `coverage_profile_version` та `coverage_contract_hash`, належати одному project і бути retained/sealed. Різні workspaces того самого project не заборонені, але Git/workspace provenance явно показується.

Порівняння різних coverage contracts і автоматичне приведення їх до спільного subset **поза MVP**. Навіть схожий набір файлів не замінює перевірку binding. Несумісна пара дає `SNAPSHOT_COVERAGE_MISMATCH` до inference та до публікації diff, який міг би помилково видати excluded file за deletion.

Зміна coverage policy створює нову version; broker не редагує старі manifests або їхній `source_digest`. Для подальшої роботи потрібні explicit compatible snapshots і, якщо immutable session policy binding змінився, нова session. Revalidation тієї самої session не дозволяє змінити її immutable policy/coverage binding або privileges. Історичні bytes, які не були captured, не можна «відновити» з поточного checkout і назвати старим baseline.

---

## 10. MCP API v0.2

Нижче визначено **власний API broker-а**, не назви vendor CLI commands. Schemas повинні бути versioned, мати `additionalProperties=false` для request objects і машинно перевірятися. IDs opaque; приклади коротких IDs наведено лише для читабельності.

### 10.1. Tools

| Tool | Основні аргументи | Результат / semantics |
|---|---|---|
| `broker_status` | `cursor?`, `limit?` для дозволених projects | Daemon readiness/incarnation, API version, resource summary, allowed project IDs; без credentials |
| `agents_list` | `project_id`, `cursor?`, `limit?` | Project bootstrap: adapters, account/workspace/policy IDs, coverage bindings, role/profile verification, configuration revision |
| `agent_session_spawn` | `project_id`, `idempotency_key`, provider/account/model config, role/instructions, workspace request, `policy_profile_id`, `policy_restrictions?` | Durable `session_id`; `PROVISIONING` або `IDLE`; без inference |
| `agent_workspace_snapshot` | `project_id`, `workspace_id`, `idempotency_key` | Explicit capture під read lease, без inference; sealed snapshot для нового precondition |
| `agent_sessions_list` | `project_id`, `cursor?`, `limit?` | Доступні owner-у sessions, compact metadata |
| `agent_session_status` | `session_id` | Session/context/runtime states, active turn, initial/latest snapshots, block/close state, coverage/policy binding |
| `agent_session_send` | `session_id`, `idempotency_key`, task contract, workspace/review binding | `turn_id` після atomic admission з required input pins; не чекає завершення inference |
| `agent_turn_status` | `turn_id` | State/version, progress metadata, deadline, managed liveness |
| `agent_turn_result` | `turn_id` | Bounded result manifest або `RESULT_NOT_READY`; `UNKNOWN` повертає partial evidence із відповідним статусом |
| `agent_turn_events` | `turn_id`, `after_cursor?`, `limit?`, `wait_ms?` | Durable bounded event page; long-poll не запускає inference |
| `agent_artifact_read` | `artifact_id`, `offset?`, `max_bytes?` | Дозволений текстовий фрагмент/manifest; binary artifacts — metadata, без dump у context |
| `agent_turn_cancel` | `turn_id`, `idempotency_key`, `reason?` | Cancellation request або вже відомий terminal status |
| `agent_session_stop` | `session_id`, `idempotency_key` | Guarded close `IDLE` або `BLOCKED`; `close_state=pending`, `completed` або `failed`; native history/worktree не видаляються (§6.4) |

Project/owner binding виводиться також із bridge profile; аргумент `project_id` не може розширити його повноваження. Для tool-ів із session/turn/artifact ID daemon перевіряє resolved project та owner ACL.

### 10.1.1. Explicit snapshot refresh

`agent_workspace_snapshot` потрібний, щоб coordinator міг свідомо прийняти новий baseline після зовнішніх змін, не створюючи fresh native session. Capture допускається лише для зареєстрованого доступного workspace, без writer-а або quarantine. Snapshot не змінює поточну native history і не знімає blocked state.

Операція має durable idempotency record. Response містить `snapshot_id` і `capture_state=CAPTURING|SEALED|FAILED`; повторний виклик із тим самим key повертає той самий capture та його актуальний стан. Новий key створює нове вимірювання source state. Лише `SEALED` snapshot можна передавати в `send` або review binding; artifact у процесі capture повертає `ARTIFACT_NOT_READY`. Багато concurrent capture requests обмежуються окремим workspace/storage admission, без inference capacity.

### 10.1.2. Project bootstrap / discovery contract

`broker_status` показує тільки project IDs, до яких bridge має чинний доступ, із display names та default project, якщо його явно задав operator. Наявність одного default не надає доступу до інших projects. Readiness `RECOVERING` позначається явно; discovery не запускає inference.

`agents_list(project_id)` повертає `configuration_revision`, `entries` та `next_cursor`. Кожна entry має `kind`, opaque `id`, display name та релевантні безпечні metadata:

| `kind` | Metadata |
|---|---|
| `adapter` | CLI/adapter versions, configured model IDs, capability evidence, verified platform/role/profile combinations та limitations |
| `account_profile` | Дозволений provider/profile ID, configured auth mode, safe availability status; жодних credentials або native secret paths |
| `workspace` | Workspace/repository ID, allowed modes, source coverage binding, availability/quarantine, display path лише якщо ACL дозволяє |
| `policy_profile` | Profile ID/version, allowed roles/providers, access/tool/network restrictions, source/non-source scopes, delivery limits/enforcement, compatibility status |

Pages мають stable ordering у межах `configuration_revision`; default 50 entries, hard maximum 100 та 64 KiB на page. `next_cursor=null` означає кінець. Cursor bound до caller/project/revision; зміна configuration дає `DISCOVERY_CHANGED`, після чого caller починає читання заново. Те саме bounded paging правило застосовується до project entries у `broker_status`. Неповна page не видається за повний список.

Для `review_slot` profile показує можливість створити broker-managed slot без caller-supplied absolute cwd. Для `worktree` discovery дає registered repository reference; `base_commit` coordinator обирає явно. Discovery не доводить доступність remote model backend або квоти: confirmed, configured і unknown properties залишаються розділеними.

Жодного нового administrative MCP tool не додається. Registration/edit profiles — operator action. Final admission повторно перевіряє актуальну configuration; застаріла discovery page не дозволяє обійти policy.

### 10.2. Spawn example

Значення model/account/policy в прикладі — локальні placeholders, не реальні vendor IDs. Реальний adapter отримує явно налаштований provider model ID; broker не використовує його для smart routing.

```json
{
  "project_id": "project-parser",
  "idempotency_key": "create-worker-001",
  "provider": "codex",
  "account_profile_id": "codex-personal",
  "model": "<explicit-provider-model-id>",
  "effort": null,
  "role": "worker",
  "instructions": "Implement bounded tasks. Do not commit, merge, or delegate.",
  "workspace": {
    "mode": "current",
    "workspace_id": "workspace-main"
  },
  "policy_profile_id": "local-code-writer"
}
```

`effort=null` означає відсутність requested override; effective value або provider default resolution повертається з attribution. User policy може вимагати явний effort для конкретного provider-а. Непідтримуваний requested effort не округлюється до «найближчого».

Після `PROVISIONING` caller читає session status до `IDLE`; для current/worktree response містить `initial_snapshot_id`. Для порожнього review slot він `null` до першого явного review binding. Reviewer spawn використовує `role=reviewer`, `workspace.mode=review_slot` і відповідний read-only policy profile. Worktree spawn містить registered repository reference та явний `base_commit`.

### 10.3. Send example

```json
{
  "session_id": "session-worker-A",
  "idempotency_key": "implement-parser-001",
  "task": {
    "goal": "Implement a bounded parser and add regression tests.",
    "acceptance_criteria": [
      "Reject truncated frames without out-of-bounds reads.",
      "Add tests for invalid length and checksum."
    ],
    "relevant_paths": ["src/parser", "tests/parser"],
    "context": "Preserve the existing public API.",
    "artifact_refs": [],
    "checks": ["Run the project parser test suite."]
  },
  "workspace_precondition": {
    "expected_snapshot_id": "snapshot-initial"
  }
}
```

```json
{
  "api_version": "0.2",
  "ok": true,
  "session_id": "session-worker-A",
  "turn_id": "turn-001",
  "state": "ACCEPTED",
  "replayed_request": false
}
```

Review send замість `workspace_precondition` містить `review_binding` з baseline/target snapshot IDs. Ці input variants взаємовиключні та перевіряються схемою.

```json
{
  "session_id": "session-reviewer-B",
  "idempotency_key": "review-parser-001",
  "task": {
    "goal": "Review the implementation for correctness and regressions.",
    "acceptance_criteria": [
      "Report actionable findings with source references.",
      "Do not modify source files or run shell commands."
    ],
    "context": "Check the parser contract, especially truncated input.",
    "artifact_refs": []
  },
  "review_binding": {
    "baseline_snapshot_id": "snapshot-initial",
    "target_snapshot_id": "snapshot-S1"
  }
}
```

### 10.3.1. Fix task із required findings artifact

Findings не потрібно копіювати в goal/context. Reference достатній, оскільки delivery тепер є обов’язком broker-а:

```json
{
  "session_id": "session-worker-A",
  "idempotency_key": "fix-parser-002",
  "task": {
    "goal": "Fix the findings supplied as the required task artifact.",
    "acceptance_criteria": [
      "Address each actionable finding or explain why it cannot be addressed.",
      "Add regression coverage for the reported parser failure."
    ],
    "artifact_refs": ["artifact-findings-R1"],
    "checks": ["Run the parser regression suite."]
  },
  "workspace_precondition": {
    "expected_snapshot_id": "snapshot-S1"
  }
}
```

До dispatch `artifact-findings-R1` має required pin та sealed entry у `TurnInputManifest`. Worker отримує сам content inline або конкретний enforced read-only path і hash. Він не повинен вгадувати, як прочитати opaque ID. Якщо artifact expired або заборонений, task не запускається; broker не покладається на можливу згадку findings у старій conversation.

### 10.3.2. Stop response та polling

Для прийнятого, але ще не завершеного close response містить `session_id`, current `state`, `close_state=pending`, `replayed_request` і `api_version=0.2`. Caller читає `agent_session_status` до `CLOSED`/`completed` або `BLOCKED`/`failed`; довге MCP wait не є вимогою. Closed response не обіцяє видалення worktree/history або зняття quarantine. Повтор того самого stop key читає existing operation.

### 10.4. Error contract

```json
{
  "api_version": "0.2",
  "ok": false,
  "error": {
    "code": "SESSION_NOT_RESUMABLE",
    "message": "The recorded native conversation could not be resumed.",
    "phase": "resume",
    "retry_guidance": "coordinator_decision_required",
    "execution_started": false,
    "session_id": "session-worker-A",
    "turn_id": "turn-002",
    "details": {
      "context_status": "missing",
      "fresh_session_started": false
    }
  }
}
```

`execution_started` може бути `true`, `false` або `null` для unknown. Воно стосується dispatch конкретного task у native execution, не самого факту запуску порожнього CLI process. Значення `false` допустиме лише коли journal/evidence виключають передачу цього task на виконання. `retry_guidance` не є наказом broker-у автоматично повторити task. Для вже прийнятого turn ця інформація також записується в його result; transport error не замінює durable status.

Категорії помилок: `INVALID_REQUEST`, `UNAUTHORIZED`, `SESSION_NOT_READY`, `SESSION_BUSY`, `SESSION_CLOSED`, `SESSION_BLOCKED`, `IDEMPOTENCY_CONFLICT`, `RESOURCE_BUSY`, `WORKSPACE_BUSY`, `WORKSPACE_CHANGED`, `SCOPE_VIOLATION`, `POLICY_UNSUPPORTED`, `CAPABILITY_UNSUPPORTED`, `PROVIDER_INCOMPATIBLE`, `MODEL_UNAVAILABLE`, `AUTH_REQUIRED`, `INTERACTION_REQUIRED`, `QUOTA_EXHAUSTED`, `RATE_LIMITED`, `PROVIDER_PROTOCOL_ERROR`, `SESSION_NOT_RESUMABLE`, `EXECUTION_UNKNOWN`, `SNAPSHOT_UNSUPPORTED`, `SNAPSHOT_UNSTABLE`, `EVIDENCE_CAPTURE_FAILED`, `STORAGE_LIMIT`, `RESULT_NOT_READY`, `ARTIFACT_NOT_READY`, `ARTIFACT_EXPIRED`, `EVENTS_EXPIRED`, `ACTIVE_TURN`, `SESSION_CLOSING`, `DAEMON_ALREADY_RUNNING`, `DAEMON_NOT_READY`, `DISCOVERY_CHANGED`, `INPUT_UNSUPPORTED`, `INPUT_LIMIT`, `INPUT_DELIVERY_FAILED`, `ARTIFACT_CORRUPT`, `SNAPSHOT_COVERAGE_MISMATCH`.

`DAEMON_ALREADY_RUNNING` — startup/local diagnostic, не дозвіл bridge запускати інший store. `DAEMON_NOT_READY` означає заборону нового admission. Artifact errors застосовуються лише після ACL check; `SNAPSHOT_COVERAGE_MISMATCH` описує несумісний contract або неповне представлення source changes, а не звичайну зміну коду. Stop з failed guard не обходить lifecycle через новий error code.

### 10.5. Polling, events і reconnect

Events мають монотонний cursor, event type, timestamp, turn ID та bounded payload. Читання сторінок не видаляє events. Повторний cursor повертає той самий committed prefix; live tail може збільшуватися. Видалений через retention діапазон дає явний `EVENTS_EXPIRED`, не порожній «нічого не сталося».

`wait_ms` обмежений operator policy. Відключення waiting caller не скасовує turn. Optional MCP notifications можуть лише підказувати про зміни; durable event retrieval залишається source of truth.

Broker не обіцяє, що idle coordinator автоматично прокинеться після completion: це залежить від MCP host. У MVP достатньо bounded polling/long-poll та reconnect retrieval. Немає внутрішнього LLM, який сам продовжить workflow.

---

## 11. Result contract та доказовість

### 11.1. Рівні даних

**`agent_reported`** — summary, findings, заявлені tests/checks, concerns і recommendations, отримані від агента. Broker може механічно валідовувати schema та обмежувати довжину, але не робить твердження істинними.

**`broker_observed`** — adapter completion/exit evidence, native context continuity metadata, запуски команд і exit codes, які adapter реально показав, snapshot references та observed workspace delta. Ці дані стосуються спостережуваного execution, не авторства всіх змін або коректності коду.

**`assessment`** — acceptance/review decision coordinator-а або людини. У MVP broker не обчислює її. Reviewer output залишається agent-reported evidence з точним snapshot binding, навіть коли provider reviewer-а відрізняється від provider worker-а.

Незалежний test runner не входить у MVP. Не можна заповнювати `independently_verified=true` тільки на основі слів агента, tool output або JUnit-файлу, створеного в його workspace.

### 11.2. Приклад result

```json
{
  "api_version": "0.2",
  "session_id": "session-worker-A",
  "turn_id": "turn-001",
  "execution_status": "SUCCEEDED",
  "quality_status": "unreviewed",
  "context": {
    "continuation": "new_native_conversation",
    "native_conversation_ref": "native-ref-A",
    "status": "available"
  },
  "agent_reported": {
    "summary": "Parser implemented; regression tests added.",
    "claimed_checks": [
      {"name": "parser suite", "passed": 42, "failed": 0}
    ],
    "concerns": []
  },
  "broker_observed": {
    "provider_turn_completed": true,
    "managed_quiescence": "confirmed",
    "input_manifest_id": "artifact-input-manifest-T1",
    "input_delivery_status": "complete",
    "delivered_task_artifact_count": 0,
    "baseline_snapshot_id": "snapshot-initial",
    "final_snapshot_id": "snapshot-S1",
    "observed_workspace_delta": ["src/parser/parser.c", "tests/parser/parser_test.c"],
    "attribution": "workspace_delta",
    "command_events": [],
    "scope_check": "passed",
    "source_inventory_id": "artifact-source-inventory-T1",
    "snapshot_coverage_status": "complete",
    "coverage_profile_id": "coverage-project-source",
    "coverage_profile_version": "1",
    "source_readonly_enforcement": "not_applicable"
  },
  "usage": {
    "availability": "unknown",
    "billing_basis": "unknown",
    "measurements": []
  },
  "artifacts": [
    {"artifact_id": "artifact-diff-S1", "kind": "patch"},
    {"artifact_id": "artifact-events-001", "kind": "normalized_events"}
  ],
  "warnings": [
    "Test counts are agent-reported; no independent test verification was performed."
  ]
}
```

У другому turn `continuation` має бути `native_resume` з тією самою native reference; broker не підміняє це значенням «reuse», якщо насправді створив нову history.

У прикладі T1 не має task artifacts, тому `delivered_task_artifact_count=0`; sealed manifest усе одно фіксує context/workspace binding. Для fix T2 count дорівнює кількості required task inputs, а manifest містить ID/hash і delivery mode findings. `input_delivery_status=complete` — broker observation доставки, не твердження, що агент усе прочитав. Coverage contract hash та повний inventory доступні через відповідні manifests; bounded result не дублює всі entries.

Для failed turn delivery/coverage fields не заповнюються як successful defaults: допустимі `not_started`, `failed`, `unknown` з error/evidence. `final_snapshot_id=null` не замінюється попереднім snapshot під виглядом нового. Result зберігає окремі `native_outcome`, `termination_reason`, `finalization_error` і `execution_started`, коли вони релевантні. Після дозволеного cleanup compact terminal record доступний, а expired content references позначаються явно (§15.3).

Protocol completion при failed tests може залишатися `SUCCEEDED` для execution, якщо агент коректно завершив task reporting. Результати тестів та unmet acceptance criteria при цьому видимі; `quality_status` не стає accepted автоматично. Scope violation, invalid mandatory output або evidence failure — broker execution failure незалежно від слів агента.

### 11.3. Compact output

Default result — один bounded manifest, а не повний transcript. Великі diffs, logs і command outputs доступні за artifact IDs. Якщо summary обрізано, result містить `summary_truncated=true` та reference на доступний повний agent message.

Якщо provider не підтримує required structured final output, adapter може віддати bounded текст як `agent_reported.summary` із `format_status=text_only`, якщо це дозволяє task policy. Він не залучає іншу модель для «виправлення JSON». Task, який вимагає строгий structured result, у такому разі fail-иться явно.

### 11.4. Usage без подвійного обліку

Кожен measurement містить `scope=turn|conversation`, `kind=delta|cumulative`, `source`, `observed_at`, currency/unit де доречно, native counter identity та `is_estimate`. Missing values — `null`/`unknown`, не нуль.

Cumulative counters не додаються як turn usage. Delta обчислюється лише між сумісними counter observations; reset, відсутній baseline або невідома provider semantics дають unknown. Cached input не додається вдруге до input, якщо native counter уже його включає; mapping перевіряється adapter contract tests.

Оцінка model/API cost, quota usage підписки та реальна додаткова оплата — різні показники. Без підтвердженого billing source broker не показує оцінку як фактично списані гроші.

---

## 12. Permissions, secrets і trust boundary

### 12.1. User policy важливіша за coordinator request

Operator створює profiles і задає максимальні можливості. Coordinator обирає profile та MAY звузити його через `policy_restrictions`; він не може розширити privileges, network access чи account permissions.

Policy preflight MUST завершитися до inference. Unsupported mandatory enforcement дає `POLICY_UNSUPPORTED`; не можна мовчки замінити sandbox на prompt instructions. Status показує requested/effective policy та перевірений спосіб enforcement.

### 12.2. Tool network не дорівнює model transport

Виклик віддаленої моделі через native CLI потребує provider transport. Обмеження `tool_network_policy` стосується мережевих дій agent tools, а не обіцянки локального inference.

Adapter повинен явно показувати, які канали він контролює. Profile із network deny не вважається реалізованим, якщо перевірено лише відсутність одного browser tool, але залишився необмежений shell/network MCP. Якщо CLI не дозволяє потрібне розділення, це capability gap, а не приховане послаблення.

Для MVP operator MAY затвердити менш суворий writer profile з явно описаними обмеженнями; reviewer read/search-only profile не отримує mutating MCP чи довільний shell. Непідтверджене обмеження позначається `unknown`, а не `enforced`.

### 12.3. Native auth і account profiles

Broker використовує явно налаштований native CLI account profile. Він не виймає OAuth tokens із browser/IDE, не копіює credentials у власний registry і не реалізує private IDE IPC.

Child environment формується allowlist-ом. Inherited API/proxy variables, які можуть непомітно змінити authentication/billing backend, не передаються без дозволеного profile. CLI-specific setup перевіряється на P0. Відсутність auth чи quota exhaustion не запускає інший account/provider/API backend.

Кілька profile aliases можуть використовувати одну реальну квоту. Для admission operator задає спільний `quota_scope_id`; default для непідтверджено незалежних profiles консервативно спільний. Назва profile сама по собі не доводить окрему підписку чи capacity.

### 12.4. Untrusted output і вкладені агенти

Repository text, tool output, findings та artifacts вважаються недовіреними даними. Вони не можуть змінити owner, permissions, invocation arguments, paths або retention. Broker не виконує shell snippets із summary.

Workers не отримують broker MCP tools, bridge credentials чи право створювати broker sessions. Native nested delegation забороняється перевіреним provider control, коли він доступний; за відсутності такого control статус гарантії позначається явно, і строгий profile відхиляється. Текстова заборона не видається за технічний захист.

Довільний shell того самого OS user потенційно виходить за межі простого environment scrubbing. MVP не обіцяє, що malicious process не зможе прочитати доступні цьому user-у credentials, звернутися до локального socket або створити некеровані subprocesses. Hard isolation для таких загроз потребує окремого OS/container profile і тестів; вона не виникає від одного worktree.

### 12.5. Process execution та logs

Invocations будуються через executable + argument array без shell interpolation. Prompt передається через stdin або protected input file, якщо native interface це підтримує. Sensitive context не кладеться в process arguments без явного дозволу; adapter, який не має прийнятного input channel, не проходить strict profile.

За замовчуванням зберігаються normalized allowlisted events, доступні assistant results та bounded redacted diagnostics. Внутрішні reasoning payloads не персистяться і не повертаються coordinator-у. Повний raw stdout «на всяк випадок» не є default.

Secret redaction — best effort, не доказ відсутності секретів. Artifact storage має user-only permissions; віддаленої telemetry та автоматичного log upload у MVP немає. Невідомі event payloads не зберігаються без фільтрації тільки тому, що parser ще не знає їхню схему.

### 12.6. Input views і незмінність policy

Per-turn input area — broker-managed data view, не writable checkout, не весь artifact store і не канал адміністративних команд. Native runtime отримує read grant лише на поточні resolved inputs; ніяких bridge credentials, storage-root allowlist або mutating broker tools. Required read-only materialization допускається тільки з перевіреним enforcement; звичайне прохання «не редагуй findings» чи postcheck не проходить цей delivery mode. Якщо worker profile цього не забезпечує, дозволений bounded inline mode може задовольнити невеликий text input; інакше pre-dispatch failure.

Broker MUST не змішувати artifact text із authoritative policy, не інтерпретувати включені paths як filesystem grants і не дозволяти artifact-у задавати invocation flags, environment або output path. Typed manifest/envelope створює core. Adapter має передати data bindings без прихованої зміни їхнього змісту. Parser не виконує shell/code із artifact.

Immutable blob storage не можна експонувати через writable aliases; input views/hash checks і ревізії потрібні також при restart. Видалення старого grant не стирає native context. Same-user hostile processes залишаються поза базовим threat model (§12.4); заявлене enforcement стосується перевіреного runtime/profile, не абстрактної абсолютної безпеки файлових permissions.

---

## 13. Provider adapter contract

### 13.1. Discovery і compatibility

`agents_list` не запускає LLM. Він повертає installed CLI/version, adapter version, configured account/model information, capability evidence та останню перевірку. Active smoke-test із inference — окрема operator action з явною згодою на usage.

Capability record:

```json
{
  "name": "resume_after_process_restart",
  "support": "native",
  "verification": "smoke_tested",
  "adapter_version": "<pinned-adapter-version>",
  "cli_version": "<tested-cli-version>",
  "verified_at": "<test-timestamp>",
  "limitations": []
}
```

`support`: `native`, `emulated`, `unsupported`, `unknown`. `verification`: `configured`, `documented`, `smoke_tested`, `failed`. Окремий `implementation_owner=provider|broker` MAY уточнювати, хто виконує можливість. Native resume не може мати статус `emulated` і проходити continuity gate.

Мінімальні capability dimensions: explicit native conversation selection, sequential follow-up, resume після process restart, resume після broker restart, cancellation/quiescence visibility, final-event parsing, structured output, model selection/identity evidence, effort selection, read-only enforcement, tool restrictions, usage semantics, stable-cwd snapshot refresh і required artifact input delivery (inline/read-only path, file/tree reading, limits).

Capability records агрегуються у **role/profile verification record** з platform, adapter/CLI versions, account/config provenance, effective worker/reviewer policy і input-delivery profile. Ізольовані тести «resume працює» та «writes блокуються» не доводять, що той самий effective profile одночасно може читати target/baseline/diff і продовжувати потрібну conversation. `supported` дозволений лише після цілісного P0 gate (§17).

### 13.2. Обов’язки adapter-а

Adapter має реалізувати inspection/preflight, explicit create-or-resume execution, normalized event streaming, cancel, runtime/context inspection і idle-runtime shutdown. Core не знає vendor flags і не парсить різні output schemas самостійно.

Для першого turn він може створити native conversation. Для наступного MUST отримати explicit persisted native reference; `last conversation`, глобальний `continue latest` або пошук найбільш схожої history не допускаються.

Adapter MUST передати native reference daemon-у одразу після її отримання. Проміжок між зовнішнім створенням conversation та durable записом ID є recovery risk; якщо crash стався в цьому проміжку, не можна автоматично створити нову conversation.

Adapter не повторює prompt самостійно, не вибирає слабшу model, не підвищує effort, не додає API fallback і не ігнорує mandatory permissions. Native internal behavior, який broker не може спостерігати чи заборонити, описується як limitation.

### 13.2.1. Adapter input-delivery obligation

Core передає adapter-у typed `TurnInputManifest`, готові authorized views та deterministic envelope. Adapter MUST перевірити, що його effective tool/sandbox restrictions дозволяють потрібні reads і enforce-ять заборонені writes; він не виправляє це додаванням shell, broad filesystem access або broker MCP. Role/profile capability має відповідати реальному поєднанню tools, а не сумі окремих несумісних modes.

До підтвердження input readiness task не dispatch-иться. Native prompt channel має вміщати повний bounded envelope і task; більший input переводиться у дозволену materialization на preflight або fail-иться, але не обрізається. Adapter не змінює sealed manifest після dispatch. Якщо mapping native paths відрізняється від host paths, він має бути explicit у manifest і перевірений до dispatch.

Для follow-up/review refresh adapter повинен читати нові bindings у тому самому native context. Stale cwd/file caches, недоступний baseline або залишений старий input path — failure required profile; fresh conversation не є виправленням. Delivery/read evidence відрізняються: відсутній native read event не перетворюється на вигадану telemetry.

### 13.3. Model identity та version drift

Session зберігає requested model та effective model з `identity_source=provider_reported|pinned_request|unknown`. Явно переданий model ID не означає, що provider підтвердив фактичний backend. Якщо policy вимагає runtime-confirmed identity, adapter без такого evidence відхиляється.

Mutable aliases не видаються за pinned immutable identity. Немає автоматичного model substitution. При спостережуваній невідповідності requested/effective model turn позначається failed або unknown залежно від execution stage; evidence зберігається.

CLI upgrade, зміна account/config або output schema поза verified profile дають `PROVIDER_INCOMPATIBLE` / blocked session до revalidation. Broker не повинен удавати, що smoke-test старої версії підтверджує нову. Видимі provider/project instruction hashes записуються як provenance; невидимі native defaults не оголошуються повністю зафіксованими.

### 13.4. Перші adapters і reuse стороннього коду

Codex adapter та Claude Code adapter повинні реалізувати той самий core contract, але MAY мати різні native transport/lifecycle implementations. Конкретний вибір Codex App Server чи іншого документованого headless path і Claude Code headless path — результат P0, не hardcoded command у цій специфікації.

`mcp-agents`, `AgentBridge`, `agent-pool-mcp`, `Agent Deck` та `Agent Orchestrator` із [SRC-01]/[SRC-02] — references для targeted inspection, не затверджені runtime dependencies. Рейтинги та припущення початкового концепту тут не повторюються як перевірені факти.

Перед code reuse агент має зафіксувати repository commit, license, dependency surface, потрібні зміни й contract-test coverage. Не переносити автоматичний retry/fresh-session fallback, routing або pipelines тільки тому, що вони вже є в донорському проєкті.

---

## 14. Persistence, recovery та quiescence

### 14.1. Durable storage

SQLite зберігає sessions, turns, idempotency ledger, reservations, runtime references, event cursors і artifact manifests. Великі blobs/logs — у protected filesystem storage. DB transactions захищають metadata transitions; SQLite не оголошується транзакцією з CLI, Git і файловими записами worker-а.

Artifact publication: staging → hash/validation → immutable blob → committed DB reference. Crash між кроками залишає recoverable staging/orphan blob, а не «успішний result» із неіснуючим файлом. Cleanup staging виконується за ownership/intent journal, не за довільним prefix path.

**Snapshot content storage v0.2:** immutable file blobs адресуються за `(project_id, SHA-256(content))` і повторно використовуються між snapshot manifests одного project. Це MUST для MVP; не потрібно зберігати повну незалежну копію кожного незміненого source file для кожного capture. Snapshot identity, manifest і provenance залишаються окремими. Cross-project deduplication, compression та delta encoding не потрібні; physical-layout reuse не розширює ACL.

Посилання на blob публікується лише після durable validation; GC видаляє blob тільки коли немає жодного retained manifest/content reference, pin або незавершеного publication/materialization intent, який його потребує. Проста відсутність explicit user pin не означає, що можна залишити retained snapshot з missing blob. Однаковий hash не дозволяє повертати artifact metadata іншого project.

Artifact budget рахує реальні occupied bytes: унікальні retained blobs, manifests/logs, staging і тимчасові input copies, а також reserved headroom; deduplication не рахується як економія до фактичного перевикористання validated blob. Managed worktrees/review slots мають окремий free-disk headroom check, бо artifact budget не є лімітом усього диска. Workload не приймається лише на підставі припущення, що майбутній output обов’язково буде deduplicated.

Native conversation history залишається в native provider storage. Broker тримає reference та profile binding. Backup тільки SQLite недостатній для перенесення conversations на іншу машину. Broker не обіцяє portable session export у MVP.

### 14.2. Що переживає який restart

| Подія | Гарантія MVP |
|---|---|
| Reconnect MCP bridge/IDE | Accepted execution продовжує daemon; result доступний за тим самим turn ID |
| Idle CLI process exit | Session і native ref збережено; наступний turn використовує explicit native resume |
| Daemon restart при idle session | Registry відновлюється; native resume перевіряється, fresh fallback заборонений |
| Daemon crash під час active turn | Стан відновлюється консервативно; seamless continuation не гарантується |
| Втрата native conversation files | Session `BLOCKED`, причина `SESSION_NOT_RESUMABLE`; після quiescence/reconciliation можна safe-close без відновлення history; нову conversation обирає coordinator явно |
| Power loss/пошкодження storage | Цілісність перевіряється; непідтверджений outcome не видається за success |

### 14.3. Launch journal і crash windows

До запуску записується `launch_intent` із turn, daemon/runtime incarnation, workspace lease та adapter input references. Sealed `TurnInputManifest`, його hash і dispatch permission MUST бути durable до передавання task на виконання. Input/view preparation має власний intent до filesystem side effects; незавершене materialization не є inference. Після process spawn зберігаються process identity і native reference, коли вони відомі. Точно-одноразового спільного commit між DB та process spawn немає.

| Crash window | Recovery |
|---|---|
| До acceptance transaction | Немає accepted turn; повторний request може бути прийнятий |
| Після acceptance, до launch intent | Відновити input pins та preparation intents; якщо journal достовірно виключає dispatch, завершити через `FINALIZING → FAILED` з `execution_started=false`, без нового prompt |
| Після launch intent, але runtime ID не записано | `UNKNOWN`; відсутній PID не доводить, що process не стартував |
| Worker змінив файли, completion не збережено | `UNKNOWN`; workspace карантинізується, replay заборонений |
| Completion відомий, sealing не завершено | Відновити `FINALIZING` без повторного inference, якщо runtime quiescence підтверджена |
| Terminal result committed, response втрачено | Повернути existing result за idempotency key/turn ID |

### 14.4. Managed quiescence

`managed_quiescence=confirmed` означає, що в межах перевірених можливостей adapter/supervisor немає active native turn, tool operations або відомих owned process groups, здатних далі змінювати цей workspace. Idle native server process MAY залишатися живим.

Process identity включає не тільки PID, а й process-start identity/incarnation та ownership metadata, доступні на платформі. PID reuse не дозволяє вбивати process лише за числом із застарілого DB record.

Daemon restart перевіряє known owned execution. Якщо reconnect/adoption підтриманий і перевірений, MAY відновити спостереження без нового task. В іншому разі він намагається зупинити лише достовірно власний process tree і залишає outcome unresolved до reconciliation. Unverifiable process не вбивається навмання.

Це гарантія для керованого execution, не доказ відсутності hostile escaped processes. Запуск unmanaged background services worker-ом заборонений profile; strict containment поза ним потребує OS isolation.

### 14.5. Reconciliation і workspace quarantine

`UNKNOWN` тримає session blocked та workspace/capacity reservations, поки потенційно існує active execution. Старі heartbeat timestamps не є підставою для звільнення locks. Новий daemon incarnation відхиляє stale metadata writes від старих RPC/adapters; це не замінює зупинку старих process-ів.

Operator-only reconciliation повинна показувати launch journal, known runtime state, provider evidence, workspace delta та partial artifacts. Вона може:

- підтвердити вже відомий terminal outcome і завершити sealing;
- підтвердити managed quiescence, зняти новий baseline і завершити turn як `ABANDONED` з unknown outcome;
- залишити quarantine, якщо execution не встановлено.

Після `ABANDONED` reuse session дозволяється лише за підтвердженої придатності native context і явного рішення operator-а з новим workspace baseline. Якщо baseline capture не вдався, gap зафіксовано і workspace не готовий для reuse. Інакше session залишається blocked; coordinator створює нову session явно. Жодна reconciliation action не повторює початковий prompt автоматично.

Після узгодженого terminal outcome quiescent blocked session можна закрити за §6.4, навіть коли native context відновити неможливо. Missing history сама по собі не є unresolved execution. Для provisioning failure operator перевіряє intent, відсутність active Git/workspace operations та фіксує retained partial output; safe close не вимагає `git clean` чи видалення workspace. Усі quarantine records мають власний lifecycle: close session їх не стирає.

Operator reconciliation ніколи не обходить `TurnInputManifest`/artifact pins: active або unresolved native execution може ще читати поточні input views. View refresh, cleanup і зняття read grants дозволені тільки після confirmed quiescence. Sealed historical evidence не редагується заднім числом, щоб узгодити його з новим workspace.

### 14.6. Cancel/deadline races

Cancellation спочатку зберігається як intent. Якщо terminal result уже committed, cancel повертає цей result без зміни історії. Dispatch permission та cancellation intent серіалізуються у control plane: якщо cancel прийнято **до** dispatch permission, task MUST NOT передаватися adapter-ом у native execution. Це перевіряється без запуску inference; уже запущений порожній/idle runtime може потребувати safe shutdown.

Dispatch permission — не доказ фактичного native dispatch. Після нього і до зовнішньої передачі prompt можливий crash/race window; для `execution_started=false` потрібне додаткове достовірне no-dispatch evidence. Якщо cancel прийшов після permission, broker ініціює interrupt, а actual native completion/termination evidence визначає candidate. Не можна оголосити «task не виконувався» лише тому, що cancel acknowledgement з’явився раніше за native start event.

Якщо completion достовірно стався до фактичного interrupt, нормальний native outcome зберігається; cancellation request залишається в audit. Якщо confirmed interrupt припинив unfinished turn — candidate `CANCELLED`, або `TIMED_OUT` для hard deadline. При недостатньому outcome/quiescence evidence — `UNKNOWN`. `FINALIZING` для вже known/quiescent completion не перетворюється на cancelled через запізнілий intent; final checks усе одно виконуються.

Hard deadline ініціює termination, але `TIMED_OUT` ставиться тільки після confirmed managed quiescence і finalization. До того стан `CANCELLING` або `UNKNOWN`. Збережені partial writes, failed coverage та evidence gaps видимі; timeout не означає rollback. Правила §6.2 можуть зробити фінальний execution status `FAILED` через mandatory evidence failure, не стираючи `termination_reason=deadline`.

### 14.7. Startup recovery barrier та close/input intents

Після lifetime ownership (§4.1.1) новий daemon входить у `RECOVERING`. До `READY` він MUST:

1. Перевірити schema/storage integrity та завантажити всі nonterminal turns, provisioning/close/capture/launch/input-publication intents, runtime identities і record revisions.
2. Відновити session slots, project session cap, account/global reservations, leases, artifact pins і storage reservations. Невизначений owned execution захищається quarantine до будь-якого нового admission. Відсутність runtime PID не означає відсутність execution.
3. Узгодити lost terminal commits/known completion за journal без повторного task; unresolved launch лишити `UNKNOWN`. Input staging/orphan blobs не видаляти за одним age/filename: спочатку встановити, що їх не потребують owned execution, retained artifact або pending intent.
4. Відновити pending close як заборону нового send. Продовжувати тільки idempotent shutdown/metadata completion для достовірно власного idle runtime; за непевного ownership/quiescence — залишити blocked/failed close, cap не звільняти. Native prompt не запускається для завершення close.
5. Зафіксувати новий incarnation/fencing і readiness. Після barrier unrelated workspaces MAY приймати turns; quarantined workspaces і blocked sessions залишаються недоступними за своїми guards.

Якщо базову integrity або коректне відновлення reservations довести не вдалося, `daemon_state=FAILED`; новий execution не допускається. Звичайна наявність правильно захищеного `UNKNOWN` не вимагає блокувати весь daemon назавжди.

Позначений recovery terminal outcome проходить той самий §6.5.3 commit/release, що і штатний. Повторний restart не дублює close/cap release, не стирає input pins active turn і не відновлює expired artifact із випадкового stale path. Старі adapter callbacks не можуть змінювати новий incarnation лише тому, що містять правильний session ID.

---

## 15. Resource limits, observability та retention

### 15.1. Запропоновані стартові defaults

Це engineering defaults для review, не ліміти конкретної підписки або рекомендація щодо допустимого використання provider-а.

| Параметр | Default MVP | Поведінка |
|---|---:|---|
| Незавершені inference turns глобально | 3 | Reservation до launch; без прихованого oversubscription |
| Незавершені inference turns на quota scope | 1 | Operator може змінити після перевірки конкретної конфігурації |
| Незавершені turns на session | 1 | Незмінний MVP invariant |
| Відкриті logical sessions на project | 20 | Idle sessions не займають inference capacity |
| Hard turn deadline | 900 s | Operator-configurable; coordinator лише в дозволених межах |
| Startup deadline | 120 s | Adapter-specific startup evidence; metadata noise не є повноцінним progress |
| Idle runtime eviction | 300 s | Лише без active turn; native context не видаляється |
| Максимальний task/context input | 64 KiB UTF-8 | Завеликий context передається через дозволені artifacts; не автоматичний truncation |
| `artifact_refs` на task | До 32 унікальних IDs | Усі required; review baseline/diff додаються системою окремо |
| Сумарний inline artifact content | До 16 KiB | У межах envelope; overflow → verified read-only delivery або explicit failure |
| Broker context envelope | До 32 KiB UTF-8, включно з inline inputs | Разом із task text до 96 KiB; менший verified native input cap має пріоритет |
| Додаткові materialized inputs на turn | До 512 MiB logical content | Сума task artifacts + baseline/diff, без target source slot; також потрібний physical headroom |
| Default result manifest | До 12 KiB | Overflow через artifact references і явні truncation flags |
| Default events page | 50 events | Hard maximum 200; також загальна byte limit |
| Long-poll `wait_ms` | До 20 000 ms | Не створює новий inference turn |
| `agent_artifact_read` page | До 64 KiB | Тільки дозволені content types, bounded response |
| Snapshot admitted source set | До 256 MiB | Preflight failure, не мовчазний partial snapshot |
| Logs/events на turn | До 32 MiB | Output-pressure policy; не накопичувати необмежено в RAM |
| Загальний artifact storage budget | 2 GiB | Unique retained bytes + staging/input copies + reservations; без required headroom admission заборонений |

Session cap рахує `PROVISIONING`, `IDLE`, `ACTIVE` і `BLOCKED`, включно з pending close; closed records не видаляються, але не займають цей cap. Guarded close (§6.4) звільняє cap без вимоги повернути missing native context. Budget налаштовується локальним operator profile, не prompt-ом агента.

Input byte limits застосовуються до decoded logical content, а physical storage budget — до фактичних blobs/copies плюс reservations. Deduplication не дозволяє передати безмежний logical input. Source target у `review_slot` обмежений source-set cap окремо; baseline/diff входять у additional inputs. Не можна записати великий log/findings у 64 KiB task text лише тому, що native CLI випадково приймає більше. Для envelope overflow broker спочатку використовує дозволену materialization; якщо обов’язкові bindings усе одно не вміщуються, `INPUT_LIMIT`.

Hard monetary/token cap вважається підтриманим лише за перевіреної native semantics. Broker deadline і output cap не видаються за точну фінансову межу. Якщо task вимагає unsupported hard cap, запит відхиляється.

### 15.2. Stalls, output pressure і quotas

Broker показує `last_event_at`, adapter heartbeat і last substantive activity окремо. Він не скасовує тривалий reasoning лише через відсутність тексту, якщо hard deadline не минув і adapter не підтвердив fault.

Системні resource limits застосовуються без LLM. Перевищення logs/parser limits ініціює контрольовану зупинку і explicit failure; воно не повинно спричинити OOM daemon-а чи обрізання критичного terminal event з наступним fabricated success.

`RATE_LIMITED` і `QUOTA_EXHAUSTED` різні. Provider reset/retry time повертається тільки якщо джерело його повідомило, з attribution. Broker не вигадує «повтори через хвилину» і не змінює account/model самостійно.

### 15.3. Retention, pinning та cleanup

**Native lifetime ≠ lifetime усіх blobs.** Logical session і native conversation можуть залишатися живими після explicit expiration старих unpinned artifacts. Metadata, idempotency ledger, context lineage, compact terminal capsules та retention tombstones не мають короткого automatic TTL. Вони потрібні, щоб old request не став новим inference і щоб missing content не виглядав порожнім result.

#### 15.3.1. Pin roots

| Root / reason | Що MUST бути pinned | Коли pin можна зняти / передати |
|---|---|---|
| Accepted/nonterminal turn | Required task inputs, expected/review snapshots, input manifest/views, поточне evidence та publication intents | Terminal commit після quiescence; latest/session/recovery roots отримують потрібні pins до release |
| `UNKNOWN` / unresolved recovery | Launch/input evidence, source baselines, partial artifacts, runtime/reconciliation data | Лише після узгодженого terminal/recovery outcome; TTL/idle cleanup не підходять |
| Незавершене provisioning / close / capture | Artifacts, staging та references, потрібні для безпечного завершення intent | Durable intent completion із визначеним disposition; збережені filesystem outputs не видаляються автоматично |
| Open worker/researcher session anchors | Initial baseline, latest usable source snapshot і latest compact result з обов’язковими source/diff/report artifacts | Атомарне перенесення latest pins при новому validated result; initial baseline — до close; unsafe recovery anchors залишаються захищеними |
| Open reviewer session anchors | Остання фактично reviewed baseline/target pair, diff і latest findings/result | Новий завершений review передає pins на нову пару; accepted review додатково pin-ить свою пару; close знімає лише session roots |
| Явний operator hold / запланований review | Оператором вибрані historical artifacts/snapshots | Explicit release hold; capability/permission лишається operator-only, новий MCP admin tool не потрібний |
| Retained snapshot/tree manifest | Усі blobs, необхідні для повного читання цього retained object | Лише після expiration/deletion усіх retained manifests, які посилаються на blob, і за відсутності інших pins/intents |

`latest compact result` не означає pin повного transcript, усіх command outputs або всієї історії findings. Required result references визначає typed result schema; bulk diagnostics/history після terminal turn можуть бути unpinned. Initial baseline лишається одним стабільним anchor, а не правилом зберігати кожен проміжний snapshot. Snapshot, отриманий окремим explicit capture та ще не bound до session/turn/hold, retained, але може бути явно вибраний operator-ом для purge.

Посилання в минулому terminal task, opaque artifact ID у native history або `retry_of_turn_id` — **historical reference, не безстроковий pin**. Новий turn зі старим artifact повинен знову пройти retained-state check та отримати pin; якщо content expired, треба explicit новий input, не відновлення зі здогадок. Coordinator, якому потрібна старіша pair для майбутнього review, має використати retained artifacts або узгоджений operator hold до їх purge.

#### 15.3.2. Atomic admission / cleanup race

Acceptance/pin creation та cleanup marking використовують одну serialized metadata boundary. Якщо acceptance першим committed pin, cleanup MUST пропустити object. Якщо cleanup першим позначив object `expired`, новий send повертає `ARTIFACT_EXPIRED` без dispatch. Доступний старий filesystem path не дозволяє обійти tombstone.

Cleanup спочатку повторно перевіряє актуальні roots, commit-ить expiration/GC intent, а потім видаляє unreferenced blobs. DB/reference publication і pending read/materialization operations враховуються до видалення. Короткий `agent_artifact_read` отримує read hold на час читання; persistent turn input — durable pin. Stale preview не дозволяє видалити object, pin-нутий після preview. Crash до/після filesystem unlink відновлюється за journal; missing retained blob без дозволеного GC — `ARTIFACT_CORRUPT`, не normal expiry.

#### 15.3.3. Operator cleanup та доступність evidence

Cleanup у MVP — operator-triggered з preview, exact selection/policy та явним підтвердженням. Preview показує pin reasons, protected objects, eligible artifacts, unique reclaimable bytes і temporary-copy/storage reservations. Немає автоматичного purge pinned evidence заради прийняття нового turn. Недостатній headroom дає `STORAGE_LIMIT` із безпечним diagnostic, а не hidden deletion.

Historical artifacts можна explicit expire-ити, **не закриваючи native session**. Close лише знімає session-root pins після guards; інші accepted turns, recovery або operator holds можуть продовжувати утримувати ті самі objects. Workspaces, dirty files і native history не видаляються звичайним artifact cleanup. Тимчасові views можуть прибиратися як завершення journaled turn preparation після quiescence; це не purge sealed historical artifacts.

Після дозволеного purge compact result/metadata містить `artifact_state=expired`; `agent_artifact_read` дає `ARTIFACT_EXPIRED`, а `agent_turn_result` повертає збережений compact capsule з явними expired references. Немає fabricated порожнього diff, fake success читання або native session reset. Record-level purge idempotency ledger — окрема explicit retention boundary за §7.3, не побічний ефект artifact cleanup.

**Перевірка storage growth.** Long-chain test має вимірювати unique retained source bytes, manifests/logs, staging, матеріалізовані views і reserved headroom окремо. Незмінні source blobs повторно використовуються; видалення історичних manifests звільняє blobs лише після перевірки всіх retained references. Економія залежить від workload, тому 2 GiB не оголошується гарантією довільної кількості turns. Тест A51 перевіряє довгу small-change chain, restart і cleanup без втрати required evidence чи native continuity.

### 15.4. Мінімальні diagnostic views

Operator має бачити daemon ownership/readiness, active turns, workspace leases/quarantines, account/global reservations, context availability, blocked/close reasons, input-delivery status, coverage/inventory errors, adapter/CLI/role-profile compatibility, pin roots, unique/staging storage usage, disk pressure та останні errors. Для цього достатньо локального CLI і MCP status tools; web dashboard не потрібний.

Logs містять correlation IDs і state transitions, але не credentials чи повні prompts за замовчуванням. Немає прихованої зовнішньої telemetry.

---

## 16. Наскрізний MVP workflow

### 16.1. Підготовка оператором

Operator встановлює та автентифікує native CLI окремо, реєструє project/account/policy/coverage profiles, source/output scopes і input-delivery restrictions, запускає daemon і підключає stdio bridge до обраного MCP host. Coordinator читає `broker_status`, чекає явної readiness через bounded polling та отримує дозволені IDs через `agents_list(project_id)`, не вигадує їх. Version/full-role-profile checks і opt-in smoke tests мають пройти до робочого запуску. Broker сам не обходить workspace trust prompts.

### 16.2. Implement → review → fix → verify

1. Coordinator отримує project bootstrap через `agents_list` і створює worker A у current/worktree із verified writer/input-delivery profile. Після provisioning отримує initial snapshot S0 та coverage binding.
2. Надсилає implementation task T1 із precondition S0. Worker може додавати нові module/test files без `git add`; independent post-turn inventory перевіряє їх у S1. Після completion coordinator отримує final snapshot S1 та bounded result.
3. Створює reviewer B іншого provider-а з verified read/search-only review slot. Надсилає review R1 для **сумісної coverage pair** S0 → S1. Broker materializes S1 у stable cwd, baseline/diff — у read-only inputs, seals manifest до dispatch.
4. Отримує findings artifact F1 із binding до S1 і надсилає fix task T2 **worker-у A** з precondition S1 та `artifact_refs=[F1]`. Findings не дублюються у goal/context. Broker перевіряє ACL/retention, атомарно pin-ить F1 і доставляє його content за manifest. Недоступний F1 не дозволяє почати T2.
5. Worker A продовжує ту саму native conversation; результат — S2 із complete source delta. Coordinator надсилає verify R2 **reviewer-у B** для S1 → S2 і за потреби додає F1 як required input. Broker refresh-ить slot лише між quiescent turns, включно з added/deleted files, та створює нові input bindings. Для загального S0 → S2 review coordinator явно надсилає інший review binding/turn; друга прихована review пара не вигадується.
6. Coordinator приймає/відхиляє роботу сам і надсилає наступний task T3 worker-у A або явно закриває sessions. Safe close невідновлюваної blocked session можливий за §6.4; `UNKNOWN` спочатку проходить reconciliation.

Очікувано: два logical agents, дві native conversations, кілька turns. Кількість process launches MAY бути більшою за два. Broker не трактує process restart як втрату logical identity. Input manifest доводить delivery, source snapshot — observed code state, reviewer findings — agent-reported assessment; ці три види evidence не підміняють один одного.

Цей workflow — перший native vertical slice після мінімального mock core, snapshots та delivery. Не потрібно чекати завершення всіх другорядних diagnostic views, щоб виявити нездійсненний required profile.

### 16.3. Навмисне оновлення workspace

Якщо користувач вручну змінив workspace після S2, старий precondition відхиляється. Coordinator може явно попросити новий snapshot, переглянути delta і надіслати task у **ту саму session** з новим expected snapshot. Це не reset conversation і не автоматичне схвалення зовнішніх змін.

Якщо turn `UNKNOWN`, цей шлях недоступний до reconciliation: новий snapshot не знімає quarantine і не доводить, що попередній worker уже зупинився.

### 16.4. Перевірка незалежності coordinator-а

Окремий smoke workflow запускається з іншого MCP host через той самий bridge contract. Provider adapters та daemon не змінюються. Ownership існуючих sessions не передається автоматично: для takeover потрібна явна operator action або той самий налаштований coordinator profile.

---

## 17. План реалізації та decision gates

### P0 — технічний spike до вибору codebase

Зафіксувати встановлені версії двох CLI, platform/runtime, native auth mode, model selection/identity attribution, create/resume protocol, history location, event parsing та effective policy. Active native tests запускаються лише зі згоди на usage. Це перевірка реальних supported interfaces, не припущення з README або цього документа.

**Gate є цілісним role/profile gate, не лише continuity gate.** Для першої заявленої platform кожен із початкових adapters має пройти worker і reviewer profiles, включно з їхніми input-delivery restrictions. Це уточнений MVP target v0.2; звуження одного adapter-а лише до worker або reviewer потребує явної зміни scope/support matrix та review, не прихованого `supported` warning.

| Обов’язкова перевірка | Evidence для проходження |
|---|---|
| Native continuity | Explicit native reference; sequential follow-up після process exit та idle daemon restart; та сама history, без fresh fallback |
| Worker profile + required inputs | Write дозволених source paths, нові source/test files без staging, читання findings, які існують лише у task artifact; працюють потрібні restrictions та input delivery |
| Reviewer profile цілком | Під одним effective read/search-only profile доступні target source, baseline tree/diff та task artifacts; source/input writes і mutating tools заблоковані; shell не додається задля читання |
| Stable review cwd + refresh | R1 читає S1, R2 в тій самій conversation — S2, включно з added/deleted source files і новими input bindings; stale files/cache не підміняють snapshot |
| Cancellation/quiescence | Long-running owned tool, cancel/deadline та підтверджене завершення здатних писати owned operations до resource release; одного parent CLI exit недостатньо |
| Auth/config/model binding | Effective profile/environment і requested/effective model attribution; drift detection, без прихованого account/provider/API fallback; прийнятний protected prompt channel |
| Ownership/input enforcement на platform | Перевірений спосіб singleton/process identity, source read-only та read-only input views для claimed modes; limitations відповідають threat model |

**Deliverables:** `provider-capabilities.md`, machine-readable platform/adapter/role/profile fixtures, native smoke-test evidence без секретів і ADR `codebase-choice.md`. Для кожної mandatory property вказати tested version/config та pass/fail, не лише посилання на vendor documentation. Optional structured-output/usage/identity properties можуть бути unknown/unsupported, **якщо** обраний task/policy не робить їх mandatory.

**Gate:** обидва providers реалізують потрібні worker/reviewer combinations на першій заявленій platform. Unsupported **mandatory** input, safety, continuity або quiescence property блокує цей profile. Просте документування відсутнього reviewer enforcement не є проходженням P0. Operator/project owner явно вирішує, чи змінювати scope/profile після review; broker не послаблює їх сам. Fresh-session fallback, summary замість required artifact та довільний shell у reviewer-а не є обходом gate.

Порівняти тонке власне core і fork за конкретними критеріями: session/turn separation, recovery, idempotency, policy/input enforcement, dependency footprint і зайва automation, яку доведеться видалити. Попередня пропозиція — невелике власне core з вибірковим reuse, але рішення приймається за spike, не рейтингом README. P0 не вимагає завершеного broker-а: native profile fixtures можна перевіряти мінімальним harness; повний integrated workflow підтверджується раннім vertical slice P1–P3.

### P1 — deterministic core із mock adapter

Реалізувати DB migrations, sessions/turns, authoritative idempotency/admission boundary, нормативні transitions, safe close, singleton/readiness barrier, artifact pins, ownership/resource admission та process abstraction. Mock adapter має відтворювати delayed completion, concurrent same-key requests, startup/cancel races, crash windows, malformed output, missing native context, failed close та cleanup/admission races без model usage.

**Gate:** unit/integration tests основних invariants проходять до підключення реальних model calls.

### P2 — workspaces, snapshots та evidence

Реалізувати registered current/worktree modes, source/output classification, independent inventory, compatible-coverage snapshots, content-addressed blobs, leases, baseline/delta, stable review slots, required input delivery/manifest, artifact paging, pin-aware cleanup і source attribution. Повинні працювати dirty initial checkout, нові untracked source files, external drift detection у спостережуваних випадках та immutable snapshot review.

**Gate:** жодного automatic destructive Git action; нові source files не губляться через відсутність staging, required inputs доступні без broad grants, cleanup не видаляє pinned content, failure не видає partial snapshot за sealed evidence.

### P3 — два native adapters і MCP bridge

Підключити перевірені native interfaces, цілісні role/profile manifests, environment/input policies, compact results та project-bound stdio MCP bridge з bootstrap discovery. Реалізувати лише advertised tools і типізовані schemas; mocks залишаються основою regression suite. Мінімальні частини P1/P2 достатні для раннього integrated vertical slice; не відкладати перевірку native workflow до завершення всіх diagnostics.

**Gate:** implement/review/fix/verify працює з тією самою парою native conversations, findings реально доставляються лише через artifact input, нові module/test files доступні reviewer-у, а S1 → S2 refresh оновлює added/deleted files та bindings. Reconnect bridge не впливає на active turn; обов’язкові role restrictions не послаблюються.

### P4 — fault injection, platform verification та product validation

Пройти acceptance matrix нижче, recovery runbook, platform/provider matrix і порівняння context strategies. README повинен містити встановлення, profiles, permissions, known limitations і сценарій відновлення `UNKNOWN`, а не лише happy path.

**Gate:** два adapters і два coordinator hosts пройшли core smoke workflow на заявлених tested platforms; жоден blocking invariant failure не приховано як unsupported warning. Неперевірені platform combinations не позначені supported.

### 17.1. Пропонована структура repository

```text
agent-broker/
  src/
    bridge/          # MCP tools, schemas, local RPC client
    daemon/          # lifecycle, RPC, singleton ownership
    core/            # sessions, turns, admission, policies
    providers/       # adapter contract, codex, claude, mock
    workspaces/      # current, worktree, review-slot, locks
    snapshots/       # coverage, inventory, manifests, capture, materialization, diff
    inputs/          # required input resolution, delivery manifests, read-only views
    runtime/         # supervisor, cancellation, reconciliation
    storage/         # SQLite, migrations, content blobs, atomic pins, retention
  tests/
    unit/
    integration/
    adapter-contract/
    fault-injection/
    native-smoke/    # opt-in; витрачає provider usage
  docs/
    provider-capabilities.md
    recovery-runbook.md
    security-boundary.md
    decisions/
```

Це одна codebase, не набір окремих deployed services. Shared schemas мають бути єдиним джерелом API contract, щоб implementation не розійшлася з документацією.

---

## 18. Acceptance matrix

Наведені нижче тести — **план приймання**, а не повідомлення про вже проведені перевірки. `Mock` означає детермінований тест без inference; `Native` — opt-in тест із реальним CLI, pinned version/profile та збереженим evidence.

| ID | Сценарій | Очікуваний результат | Рівень |
|---|---|---|---|
| A01 | Повторити `spawn` після втрати response | Один session ID і один workspace; provisioning не дублюється | Mock |
| A02 | Повторити accepted `send` з тим самим key після зміни mutable session state | Той самий turn ID; один dispatch; existing operation не маскується busy/closed state | Mock |
| A03 | Той самий key з іншим goal/snapshot | `IDEMPOTENCY_CONFLICT`, без execution | Mock |
| A04 | Два concurrent sends однієї session з **різними** keys | Один прийнятий turn, другий `SESSION_BUSY`; same-key scenario перевіряється A40/A41 | Mock |
| A05 | Два writers через aliases одного checkout | Один exclusive lease; другий `WORKSPACE_BUSY` | Mock |
| A06 | Writers у різних worktree | Паралельний launch у межах global/account capacity | Mock + Native |
| A07 | Уже dirty checkout до першого task | Baseline містить старі зміни; result delta не приписує їх worker-у | Mock |
| A08 | External edit після snapshot | Старий precondition відхилено; новий explicit snapshot дозволяє продовжити ту саму session | Mock |
| A09 | Другий task після завершення CLI process | Той самий native conversation ID; provider resume реально викликано | Native |
| A10 | Idle session після daemon restart | Native continuation відновлено без fresh history | Native |
| A11 | Missing native history | `SESSION_NOT_RESUMABLE`; жодного нового native conversation | Mock + Native |
| A12 | Reviewer R1 → fix → reviewer R2 | Та сама reviewer conversation; target code точно відповідає S1 та S2 відповідно | Native |
| A13 | Worker змінює свою версію, reviewer читає S1 | Reviewer бачить sealed S1, не moving worker checkout | Mock + Native |
| A14 | Спроба reviewer-а писати source/використати mutating tool | Required read-only/profile обмеження справді блокують дію | Native |
| A15 | Unenforceable required policy | Запит відхилено до inference, без advisory fallback | Mock |
| A16 | Bridge disconnect під час turn | Daemon продовжує; reconnect читає той самий turn/result | Mock + Native |
| A17 | Crash після launch intent до persisted PID | `UNKNOWN`, без автоматичного повторного task | Fault injection |
| A18 | Crash після file write до completion record | Workspace quarantine; evidence/reconciliation, без replay | Fault injection |
| A19 | Crash після completion до artifact publication | Завершення sealing без нового inference або явний evidence failure | Fault injection |
| A20 | Cancel / completion race | Один узгоджений terminal result; жодного подвійного release | Mock + Native |
| A21 | Hard deadline, owned child tool process ще працює | Не оголошувати `TIMED_OUT`/free workspace до managed quiescence; parent exit недостатній | Fault injection + Native |
| A22 | Stale PID, PID reuse, stale daemon event | Не kill-ити сторонній process; stale state update відхилено | Platform integration |
| A23 | Кілька aliases одного quota scope | Capacity спільна; немає hidden oversubscription | Mock |
| A24 | Model/effort/auth/profile mismatch чи quota error | Явна помилка; не змінено provider/account/backend | Mock + Native |
| A25 | Agent каже «tests passed», evidence відсутнє/суперечить | Claims відокремлені; quality не auto-accepted | Mock |
| A26 | Cumulative usage repeated після resume | Немає подвійного сумування; unknown semantics не стають нулем | Adapter contract |
| A27 | Великий output, malformed event, disk full | Bounded memory; explicit failure/partial evidence, не fabricated success | Fault injection |
| A28 | Secret/oversized/unsupported source у declared coverage або writable source set | Explicit failure; жодного silent omission. Дозволені non-source exclusions тестуються окремо | Mock |
| A29 | Інший coordinator/project просить send/read artifact | ACL denial; context і execution чужого project не розкриваються | Mock |
| A30 | Stop idle session / cleanup dirty worktree | History збережена; dirty files не видалені автоматично | Mock + Native |
| A31 | Повторна event page / reconnect cursor | Committed events доступні повторно; gaps/expiry позначені явно | Mock |
| A32 | CLI upgrade поза validated profile | Revalidation required; старий smoke-test не вважається доказом сумісності | Mock + Native |
| A33 | Запуск із другого MCP coordinator host | Той самий API/lifecycle без host-specific core logic | Native |

### Додаткові acceptance tests v0.2 (A34–A53)

Наступні тести доповнюють A01–A33; вони також **не виконані** під час редагування документа. Мок-тести перевіряють control-plane invariants, native — реальний effective profile.

| ID | Сценарій | Очікуваний результат | Рівень |
|---|---|---|---|
| A34 | Findings/marker і потрібне виправлення існують лише у artifact; task text містить тільки ID | Worker читає delivered content дозволеним каналом і виконує перевірюване виправлення; manifest має правильні ID/hash; та сама native conversation | Mock + Native |
| A35 | Required artifact foreign/unknown, unsealed, expired, oversized, unsupported або corrupt | Відповідна ACL/readiness/input error; жодного dispatch з пропущеним input; post-acceptance failure записано з правдивим `execution_started` | Mock + Fault injection |
| A36 | Спроба змінити input view, прочитати весь store, inject path/flags або використати writable hardlink на blob | Read grant обмежений; required write denial enforced; policy/paths не походять з artifact text; sealed blobs незмінні | Mock + Native |
| A37 | Worker створює module і regression test без `git add`, зокрема Git-ignored file всередині writable source prefix | Independent inventory бачить нові files; S1 містить bytes/hash; reviewer їх читає; index не змінюється для capture | Mock + Native |
| A38 | Write scope не покритий source selector; post-turn source поза coverage; дозволений generated output; write поза policy | Pre-dispatch або finalization `SNAPSHOT_COVERAGE_MISMATCH` за stage; allowed output класифікований окремо; forbidden write — `SCOPE_VIOLATION` | Mock |
| A39 | Baseline/target або expected snapshot мають інший profile/version/contract hash | `SNAPSHOT_COVERAGE_MISMATCH` до native dispatch і misleading diff; excluded file не видається за deletion | Mock |
| A40 | 50 simultaneous same-key/same-payload sends із двох bridges; повтор після reconnect/restart | Один durable turn ID і один native dispatch; всі authorized equivalent replies після acceptance — replay, не `SESSION_BUSY` | Mock + Fault injection |
| A41 | Concurrent same-key/different-payload requests та DB unique-key conflict | Один accepted payload; решта — `IDEMPOTENCY_CONFLICT`; unique conflict не витікає generic DB/busy error; no extra dispatch | Mock |
| A42 | Replay accepted operation після revoke ACL; окремо replay після зміни capacity/close/expired historical inputs | Revoked caller отримує `UNAUTHORIZED`; authorized replay повертає existing operation без нового preflight/execution і з явною доступністю artifacts | Mock |
| A43 | Missing-history і failed-provisioning sessions багаторазово safe-close-яться | Після quiescence/intent reconciliation `BLOCKED → CLOSED`, cap звільняється один раз; native restore та destructive cleanup не потрібні | Mock + Native |
| A44 | Stop для `UNKNOWN`, active turn або unresolved provisioning/owned shutdown | Explicit guard failure; session cap, turn resources і quarantine не знімаються; `force_close` відсутній | Mock + Fault injection |
| A45 | Усі дозволені/заборонені transitions; cancel до dispatch permission; startup failure; evidence failure; late terminal events | Поведінка §6.5/§14.6; нуль inference для раннього cancel; єдиний terminal commit/release; known evidence failure не стає fabricated success/unknown | Mock |
| A46 | Два simultaneous daemon starts, path aliases, живий owner із застарілим heartbeat/socket response | Один lifetime owner; інший `DAEMON_ALREADY_RUNNING`; socket/lock не викрадено або видалено | Platform integration |
| A47 | Restart із launch/input/close intents та late events старого incarnation | До barrier немає нового admission; reservations/pins/quarantine відновлені; stale writes rejected; READY дозволяє лише безпечні unrelated resources | Fault injection |
| A48 | Новий coordinator без наперед відомих workspace/policy IDs; paging, чужий project, config drift | Повний authorized bootstrap отримується через API; жодних guessed IDs/credentials; stale cursor — `DISCOVERY_CHANGED`; admission revalidates | Mock + MCP integration |
| A49 | Cleanup racing з accepted input/snapshot pin, read hold, publication або restart | Pin winner зберігає content; cleanup winner дає explicit expiry до dispatch; retained manifests не мають dangling blobs; immutable views не refresh-яться до quiescence | Mock + Fault injection |
| A50 | R1/S1 → fix → R2/S2 з added/deleted files, великими path-delivered findings і новими input locations | Та сама reviewer conversation/cwd; exact current source та inputs readable під read/search-only profile; без shell/broker MCP/fresh fallback | Native |
| A51 | 100 small-change mock turns на fixture зі значним незмінним source set; restart, selective operator cleanup, expired old references | Physical growth відповідає unique blobs + manifests/logs/views/reservations; pinned evidence цілісне; unpinned history expire-иться явно; logical/native refs збережені, native smoke підтверджує continuation | Mock + opt-in Native subset |
| A52 | Concurrent send/stop; same-key stop replay; crash після close intent та після cap release; idle shutdown failure | Або send admitted і stop відхилено, або close intent блокує send; один close/cap release; невідомий shutdown лишає blocked; restart не породжує inference | Mock + Fault injection |
| A53 | Повний worker/reviewer P0 profile кожного adapter-а; long-running owned tool продовжує писати після parent CLI exit | Mandatory controls працюють разом; parent exit не звільняє workspace; непідтверджений profile не отримує supported status | Native |

A40 виконується за достатньої початкової capacity і без unrelated transient rejection; A41 не фіксує, який із різних payloads переможе race. A51 не є обіцянкою необмежених turns у 2 GiB: fixture і headroom мають бути явно визначені, а облік порівнюється з очікуваними unique bytes. Native subset не підміняє решту fault/invariant tests.

### 18.1. Критерій готовності

MVP готовий до використання після проходження обов’язкових core/fault tests A01–A53 у застосовних test layers і native smoke tests для оголошеної platform/adapter/role/profile support matrix. A34–A53 закривають зміни v0.2 і не є необов’язковими через нову нумерацію. Known limitations задокументовані, але жоден із INV-01…INV-15 та mandatory role/profile requirements не може бути «обійдений» непомітною підміною behavior. Accepted exceptions можливі лише через явну зміну scope/specification, не marker `unsupported` усередині advertised profile.

Platform/adapter/role/profile combinations, які не пройшли перевірку, позначаються `unverified`; відомий failure — `failed`, не просто відсутність тесту. Наявність двох файлів adapters у repository не є доказом multi-vendor support. Редакційне трасування R01–R08 не замінює test evidence; список виконаних tests із pinned versions публікується тільки після фактичного запуску.

---

## 19. Перевірка гіпотези context reuse

Мета — не довести наперед, що persistent session завжди дешевша, а виміряти, чи вона допомагає для пов’язаних дрібних задач користувача.

Порівняти три режими на однакових task chains:

1. Нова native session на кожен task.
2. Одна native session на implement → fix → next task; окрема persistent reviewer session.
3. Нова session з compact handoff, який явно передає coordinator. Це benchmark scenario, не автоматична memory subsystem broker-а.

Фіксувати model/effort/profile, task set, workspace starting snapshots і acceptance criteria. Порядок режимів варто чергувати; повторити серії, а не робити висновок з одного успішного запуску. Витрати на створення handoff, coordinator polling і review враховуються, якщо їх можна спостерігати.

Основні метрики: end-to-end accepted task chains, кількість fix cycles, correctness/regressions за спільними критеріями, latency, native conversation starts, model usage з коректною counter semantics, cached/uncached input де доступно та обсяг output у coordinator context.

Coordinator usage, який MCP host не надає, позначається unknown; його не можна підміняти worker-only usage і називати «повною економією». Дані різних billing bases не агрегуються в одну грошову цифру без обґрунтованого mapping.

Для MVP немає вигаданого target «мінус 50% токенів». Функціональна користь continuity та фактична ефективність мають окремі висновки. Якщо reuse гірший на довгих або застарілих histories, coordinator повинен мати дані для explicit fresh session, а не примусовий нескінченний reuse.

---

## 20. Питання для незалежного reviewer-а

Ця редакція вже містить запропоновані defaults, тому reviewer-у не потрібно самостійно домислювати невизначений API. Водночас перелічені нижче рішення ще не є доведеними властивостями реалізації.

| Рішення | Поточна пропозиція | Що потрібно перевірити / оскаржити |
|---|---|---|
| D01. Codebase | Тонке нове core + targeted reuse | Чи tested fork справді менший за власне core після видалення зайвої automation? |
| D02. Перші providers | Codex + Claude Code | Цілісні worker/reviewer profiles, native continuation, input delivery, safe cancellation і stable review cwd на реальних версіях |
| D03. Runtime stack | TypeScript + Node.js + SQLite | Process-control libraries, migrations, event streaming; не конкретна модна версія |
| D04. Platforms | macOS + Linux; Windows через WSL2 | Чи достатньо це для першого застосування; які pairs реально тестуються першими? |
| D05. Persistence | Daemon + bridge; active crash → conservative recovery | Чи достатньо idle recovery для MVP, без вимоги seamless active adoption? |
| D06. Scope | Без automatic workflow, retries, merges, native fork і UI | Чи будь-яка з цих функцій справді потрібна для основного сценарію? |
| D07. Workspace policy | Один writer; complete source coverage; explicit snapshots; read-only reviewer/input views | Чи нові files, coverage compatibility, required artifacts і refresh paths закривають реальний repo workflow? |
| D08. Security boundary | Trusted local operator; explicit enforcement metadata | Чи жодне best-effort обмеження не видане за hard sandbox? |
| D09. Evidence | Claims окремо; independent test runner відкладено | Чи coordinator може оцінити результат без оманливого «tests passed»? |
| D10. Defaults | Обмежений parallelism/input/output, deduplicated storage і explicit pins | Чи long-chain cleanup і safe close не створюють cap/storage leaks або uncontrolled usage? |

### 20.1. Формат бажаного review

Для кожного finding вказати severity (`blocker`, `major`, `minor`), розділ/інваріант, конкретний failure scenario, чому поточний контракт його не закриває, та мінімальну запропоновану зміну. Відділяти суперечність документа від неперевіреного provider behavior і від необов’язкового future enhancement.

Особливо перевірити транзакційні межі idempotency/admission/launch і pin/cleanup, чинну ACL на replay, no-dispatch cancellation, source coverage нових untracked files, required input delivery, safe-close blocked sessions, singleton/readiness, orphan processes і єдиний resource release. Окремо перевірити snapshot refresh без reset reviewer-а, повний role/profile P0 gate, source attribution та різницю між execution success і прийняттям задачі. Для R01–R08 звірити нормативні розділи з acceptance tests у §0.3; не вважати finding доведеним у реалізації або закритим тестом лише через його опис у v0.2.

Не розширювати MVP до повноцінного orchestration framework без показаного failure основного workflow. Спочатку шукати простіший контракт, який зберігає invariants.

### 20.2. Вказівка агенту, який реалізовуватиме MVP

Почати з P0 і перевірки цієї специфікації v0.2. Не обирати fork за рейтингом концепту, не вигадувати vendor flags, не вважати README достатнім evidence і не запускати paid/quota-consuming smoke tests приховано. Після цілісного role/profile spike оформити ADR, оновити unsupported/unknown properties і лише тоді закріпити implementation contract. Першим integrated slice виконати §16.2 з required findings delivery та тією самою парою native conversations; повторне review має перевіряти явні guards і tests, а не розширювати scope замість усунення суперечностей.

**Очікуваний результат MVP:** coordinator із будь-якого перевіреного MCP host керує двома різними native CLI providers, повторно використовує worker/reviewer context між turns і отримує відновлюваний, обмежений та чесно атрибутований execution result — без другого LLM-планувальника, прихованих retries або мовчазної втрати сесії.
