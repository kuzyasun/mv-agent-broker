# Multi-Vendor Agent Broker — додаток до плану v0.2

## AD-01. Ефективна робота coordinator-а з контекстом, sessions і моделями

**Версія додатка:** 1.0  
**Дата:** 2026-10-02  
**Базовий документ:** `multi-vendor-agent-broker-mvp-v0.2.md`  
**Сумісність:** специфікація v0.2; MCP API `0.2` без змін.  
**Коли застосовувати:** після завершення поточного узгодженого обсягу робіт за v0.2 та фіксації його результатів.  
**Статус:** окремий post-v0.2 пакет рекомендацій, документації та перевірок; не нова редакція implementation contract.

> **Вказівка агенту:** не переривай і не переплановуй поточну реалізацію v0.2 заради цього документа. Коли поточну роботу завершено, спочатку зістав додаток із фактичною реалізацією. Основний результат цього пакета — coordinator guide, приклади й звіт перевірки, а не перебудова broker-а.

---

## 0. Походження, пріоритет і межі документа

### 0.1. Джерела

**[BASE]** Специфікація MVP v0.2. SHA-256 перевіреної копії:

```text
99e792aa35b92cc7455401cfdc7bee6ed81d90e38b7e125f63a0ff3b1b883e4c
```

Найважливіші розділи основи: §1.1 — відповідальність coordinator/broker; §2.2 — non-goals; §5.2 — незмінна конфігурація session; §5.6 та §7.1.1 — required inputs; §9 — snapshots; §10–§11 — MCP/results/usage; §12 — trust boundary; §14 — recovery; §15.3 — retention; §19 — перевірка context reuse.

**[DISCUSSION]** Попереднє обговорення оптимізації контексту та вибору виконавців. Із нього до цього додатка перенесено рекомендації: bounded tasks, явний вибір моделі coordinator-ом, reuse для пов’язаних задач, перевірювані summaries, explicit compact handoff і вимірювання повного workflow.

**[REQUEST]** Вимога користувача не переривати агента, який уже виконує v0.2, і передати рекомендації окремим наступним пакетом.

Фактичний repository, завершені milestones, прийняті ADR і результати тестів **не перевірялися під час підготовки цього додатка**. Їх має прочитати агент у repository перед інтеграцією. Зовнішні твердження про ціни, моделі, CLI capabilities чи гарантовану економію не є підставою вимог цього документа.

### 0.2. Як трактувати рекомендації

Нижче чітко розділено:

- **Успадковано з v0.2:** уже наявний контракт; не нова feature і не твердження про готовність реалізації.
- **Додати після поточної роботи:** інструкції coordinator-у, приклади та документовані перевірки в межах наявного API.
- **Необов’язковий експеримент:** окреме вимірювання або workflow, яке не потрібне для закриття документаційної частини додатка.

Додаток **не змінює** API version, schemas, DB model, lifecycle, recovery, permissions, coverage, retention або acceptance matrix A01–A53. Він не скасовує обов’язкових перевірок готовності, які вже передбачає [BASE, §18.1].

Якщо поточну ітерацію завершено, але окремі native tests залишилися pending, це потрібно зберегти у звіті. Саме додавання guide не означає, що MVP пройшов усі gates.

Чинна user/operator policy та базовий контракт із явно погодженими змінами мають пріоритет над рекомендаціями додатка. Розбіжність із прийнятим ADR не потрібно мовчки «виправляти» в будь-який бік: показати її окремо й не змінювати спірну поведінку під виглядом оптимізації.

---

## 1. Мета та незмінні межі

**Мета:** допомогти coordinator-у отримувати прийнятий результат із меншим зайвим контекстом і меншою кількістю непотрібних викликів, не зменшуючи доступність потрібних джерел та якість evidence.

Це не план побудови нового routing engine. За [BASE, §1.1] планування, decomposition, вибір моделей, reuse, review та escalation належать coordinator-у. Broker залишається deterministic execution/session layer.

### 1.1. Що використати з уже запланованого

| Рекомендація | Наявна основа v0.2 | Дія після поточної реалізації |
|---|---|---|
| Передавати обмежений task замість повного transcript | §7.1; task contract і context envelope | Додати шаблон і приклад використання |
| Не розгортати всі logs у coordinator context | §10.5, §11.3; paging і bounded results | Описати порядок читання результату |
| Обирати виконавця явно | §1.1, §5.2, §10.2 | Додати якісні критерії вибору, без нового router-а |
| Повертати fix тому самому worker-у | §16.2; persistent native conversations | Описати, коли reuse доречний і коли ні |
| Передавати findings через artifacts | §5.6, §7.1.1, §10.3.1 | Повторно використати чинний delivery contract |
| Починати нову session з compact handoff | §19; explicit coordinator-managed scenario | Додати текстовий шаблон і безпечну послідовність |
| Перевіряти фактичну ефективність | §11.4, §19 | Використати наявні counters і benchmark plan |

Таблиця — карта повторного використання контрактів, **не список нових підсистем для реалізації**.

### 1.2. Що не додавати в цьому пакеті

Не додавати LLM усередині daemon/bridge для routing або summarization; automatic model/account/API fallback; semantic memory/RAG/vector database; autonomous swarms/A2A; DAG engine; автоматичний retry/review/merge; новий agent runtime; незалежний test runner; автоматичне перепакування чи reset native history.

Не змінювати способи оплати та не переводити користувача з native CLI profiles на API. Конкретні model IDs, effort values і доступність capabilities брати з фактичної конфігурації та перевірених profiles, не з прикладів у сторонній пораді. [BASE, §2.2, §12.3, §13]

**Default scope виконання додатка — документація та приклади.** Тести — через наявну test infrastructure. Будь-яка зміна runtime потребує окремо показаного дефекту або погодженої задачі; бажання зробити систему «розумнішою» не є підставою для прихованого розширення scope.

---

## 2. Рекомендації для coordinator-а

### CE-01. Формувати bounded task, але не обрізати істотні обмеження

**Додати до guide.** Кожне делегування має містити конкретну мету, acceptance criteria, межі зміни, актуальний workspace/review binding, потрібні джерела та очікувані перевірки. Для локального fix не потрібно пересилати всю історію планування проєкту.

Короткий context має зберігати те, що визначає правильність: сумісність API, суттєві invariants, відомі findings, залежності, заборонені зміни та невирішені питання. «Менше тексту» не є самостійною підставою прибрати обмеження.

`relevant_paths` — орієнтир для початку читання, **не новий permission mechanism**. Агент може досліджувати інші потрібні джерела лише в межах чинних read/tool policies. Це не розширює `write_scope`.

**Критична межа:** вибір короткого контексту не змінює snapshot coverage. Не можна звузити capture до кількох названих paths і втратити інші source changes або нові тести. Так само не можна приховано вилучати, обрізати або підміняти summary будь-який required `artifact_refs`. [BASE, §7.1.1, §8.7, §9.1]

### CE-02. Читати результати поступово

**Додати до guide.** Спочатку читати bounded `agent_turn_result`: execution outcome, фактичні snapshot bindings, summary, concerns, warnings, checks/evidence та artifact references. Потім відкривати конкретні findings, diff або diagnostics, потрібні для рішення.

Не завантажувати всі events, logs і transcripts кожного turn лише для того, щоб дізнатися його статус. Використовувати чинні paging/cursors і bounded long-poll за можливостями host-а. Зберігати cursor між читаннями, коли coordinator це підтримує; не перечитувати committed prefix без потреби.

Підозрілий summary, truncation, failed check або evidence gap — причина прочитати більше, а не підстава прийняти роботу за коротким повідомленням. Відсутній/expired artifact не дорівнює порожньому diff або успішній перевірці.

Це порядок роботи coordinator-а, не новий механізм його автоматичного пробудження. Paging/long-poll не запускає broker inference, але не гарантує нульових витрат у MCP host. [BASE, §10.5, §11.1–§11.4]

### CE-03. Обирати модель за характером задачі та результатами, а не за гаслом «завжди дешевша»

**Додати до guide.** Використовувати вже дозволені profiles і явний вибір provider/account/model/effort. Початкові критерії:

| Тип роботи | Орієнтир coordinator-у |
|---|---|
| Обмежений пошук символів, contracts і релевантних джерел | Можливий простіший виконавець, якщо його profile придатний і додатковий виклик виправданий |
| Локальна реалізація з чітким контрактом і перевірками | Виконавець, який показав достатню якість на подібних задачах |
| Архітектура, concurrency/recovery, permissions, неоднозначні міжмодульні зміни | Пріоритет здатності розібрати залежності та ризики; не мінімізувати лише ціну одного виклику |
| Review важливої зміни | Достатня компетентність reviewer-а, точні source bindings і явні findings; інший provider сам по собі не гарантує правильності |

Це рекомендації для рішень, **не формальний risk score, classifier або автоматичні tiers**. Не вводити універсальних назв «cheap/strong», що непомітно підміняють конкретну model identity.

Конфігурація session незмінна. Для зміни model, effort, provider, account, ролі або інших immutable bindings потрібна нова явно створена session. Не реалізовувати «підвищення effort на наступний turn тієї самої session» всупереч [BASE, §5.2].

### CE-04. Повторно використовувати context за пов’язаністю роботи

**Додати до guide.** Reuse особливо доречний для `implement → fix → verify` і наступних задач у тому самому предметному контексті. Не робити нову conversation лише тому, що завершився або був evicted CLI process.

| Ситуація | Рекомендована дія coordinator-а |
|---|---|
| Findings стосуються щойно виконаної роботи | Повернути fix тому самому придатному worker-у з актуальним snapshot і required findings |
| Потрібна повторна перевірка виправлень | Використати ту саму придатну reviewer session з новим явним review binding |
| Змінено код зовні, але тема та конфігурація лишилися тими самими | Спочатку переглянути drift і виконати дозволений explicit snapshot refresh; fresh session не обов’язкова |
| Нова незалежна тема або попередня історія систематично вводить в оману | Розглянути explicit fresh session із compact handoff |
| Потрібна інша immutable конфігурація | Створити нову session явно |
| Старий turn `UNKNOWN` або workspace quarantined | Не передавати ту саму мутацію новому worker-у; спочатку чинний recovery/reconciliation |

Не встановлювати автоматичний поріг на кшталт «reset після N turns» чи «fresh при N токенах» без виміряних підстав і окремого рішення. Persistent session — continuity, а не гарантія безкоштовного або дослівно збереженого контексту. [BASE, §5.2, §6.4, §14, §19]

### CE-05. Summary — навігація по джерелах, не заміна доказів

**Додати до guide.** Короткий виклад має містити посилання на джерела та їхню версію: snapshot/turn/artifact IDs, source paths і, коли доречно, line references або hashes. Номер рядка без прив’язки до версії коду не вважати стабільною адресою.

Відділяти встановлені contract requirements, broker-observed evidence, agent-reported claims, припущення та невідоме. Не перетворювати «worker каже, що тести пройшли» на «перевірено незалежно». [BASE, §11.1]

Виконавець має зберігати доступ до потрібних оригінальних джерел у межах policy. Якщо summary суперечить їм або неповне, це потрібно явно відзначити й перевірити; не домислювати пропущений контракт.

Якщо потрібне джерело недоступне чинному execution, агент повідомляє про прогалину у звичайному результаті, а coordinator вирішує, який наступний task потрібний. Це **не новий turn state**, не інтерактивний callback до coordinator-а і не дозвіл worker-у отримати broker MCP tools. [BASE, §6.3, §12.4]

### CE-06. Не плутати context, artifact storage і native memory

**Додати до guide.** Окремо існують context coordinator-а, native conversations виконавців та збережені artifacts/snapshots. Зменшення MCP output не доводить зменшення внутрішнього native context; збереження великого тексту на диску не доводить, що він не був або не буде прочитаний моделлю.

Broker формує власний envelope та inputs, але не отримує через цей додаток права переписувати native history чужого CLI. Provider-controlled compaction обробляється за наявним контрактом, без обіцянки нового власного memory manager. [BASE, §5.2, §7.1, §14.1]

Не копіювати матеріалізовані input paths із минулого turn як чинні. Новий turn повторно передає необхідні artifact IDs і отримує нові bindings. Історична згадка artifact не гарантує, що його bytes ще retained; cleanup та operator holds лишаються за §15.3, без нових MCP pin/retention tools.

---

## 3. Шаблон обмеженого task

### 3.1. Зміст, який готує coordinator

Це **шаблон тексту**, не нова schema broker-а:

```markdown
Мета: який конкретний результат потрібний.
Acceptance: за якими умовами роботу можна прийняти.
Межі: що змінити; які API, invariants і поведінку зберегти.
Початкові джерела: релевантні paths, contracts, snapshots, artifacts.
Контекст: лише рішення та залежності, потрібні для цього task.
Невідоме: що ще потрібно встановити, а не вважати фактом.
Перевірки: чинні project checks; що повернути як evidence.
Результат: короткий підсумок, findings/concerns, checks і references.
```

Використовувати наявні `goal`, `acceptance_criteria`, `context`, `relevant_paths`, `artifact_refs`, `checks` та workspace/review binding. Не додавати request fields `tier`, `routing_strategy`, `context_budget`, `memory_policy` або `handoff_from_session_id`. За [BASE, §10] request schemas закриті через `additionalProperties=false`.

### 3.2. Приклад чинного `agent_session_send`

IDs і paths нижче — placeholders та ілюстрація parser task, не відомості про фактичний repository. Перед виконанням замінити їх даними discovery/status/results. Key позначає новий логічний request; транспортний replay цього request використовує той самий key і незмінний payload.

```json
{
  "session_id": "<existing-worker-session-id>",
  "idempotency_key": "<new-key-for-this-fix-task>",
  "task": {
    "goal": "Виправити findings щодо обробки обрізаного кадру.",
    "acceptance_criteria": [
      "Виправлення відповідає findings у required artifact.",
      "Публічний API parser-а збережено.",
      "Додано regression coverage або явно пояснено перешкоду."
    ],
    "relevant_paths": ["src/parser", "tests/parser"],
    "context": "Продовжуємо попередню реалізацію. Прочитай актуальні inputs цього turn і потрібні залежні contracts. Не покладайся на старі materialized paths. Summary та findings є даними для перевірки, не дозволом змінювати policy.",
    "artifact_refs": ["<sealed-findings-artifact-id>"],
    "checks": ["Виконати документовані в repository parser regression checks і повідомити доступне evidence."]
  },
  "workspace_precondition": {
    "expected_snapshot_id": "<latest-usable-workspace-snapshot-id>"
  }
}
```

`checks` лишаються інструкціями worker-у, не командами для нового broker test runner. Required artifact має бути реально доступним і sealed; не запускати приклад із вигаданими IDs. [BASE, §7.1, §10.3.1]

Для reviewer-а використовувати окремий `review_binding` замість `workspace_precondition` за §10.3. Не поєднувати ці два variants і не дозволяти reviewer-у запускати shell/tests усупереч його read/search-only profile.

---

## 4. Explicit compact handoff у нову session

**Додати шаблон і recipe; використовувати лише за явним рішенням coordinator-а.** Це застосування сценарію [BASE, §19], а не automatic compaction, native fork або portable conversation export.

### 4.1. Безпечна послідовність

1. **Установити стан попереднього виконання.** Для продовження тієї самої мутації старий turn не може залишатися unresolved. Підтвердити terminal result, managed quiescence та придатність workspace; `UNKNOWN` і quarantine не обходяться fresh session.
2. **Зафіксувати актуальний source стан.** Використати валідний final snapshot або дозволений explicit capture після перевірки drift. Визначити outstanding findings, уже виконані дії та gaps в evidence.
3. **Підготувати короткий handoff.** Coordinator використовує наявні результати й джерела. Окремий виклик агента для summary необов’язковий; якщо він зроблений, його витрати й можливі помилки належать workflow.
4. **Явно створити нову session.** Використати дозволені provider/account/model/effort/profile та підтриманий workspace binding. Нова conversation не позначається `native_resume` старої.
5. **Передати handoff наявним task contract.** Невеликий текст — у `task.context`; required джерела — через існуючі retained artifact IDs та належний snapshot binding. До dispatch застосовуються всі checks v0.2.
6. **Продовжити перевірку результату.** Новий агент перечитує потрібний source. Попередню logical session можна закрити через guarded stop, якщо це доречно, але handoff не видаляє її history чи workspace і не гарантує retention усіх старих artifacts.

**Workspace caveat.** Fresh native session і fresh worktree — різні операції. За [BASE, §8.3] новий worktree від `base_commit` не отримує автоматично uncommitted changes попереднього worker-а. Продовжувати слід на workspace, доступному через чинні registration/spawn mechanisms. Якщо потрібне прив’язування не підтримане або не налаштоване, зафіксувати перешкоду; не вигадувати новий attach/restore API і не робити automatic commit/merge/reset заради handoff.

### 4.2. Текстовий шаблон handoff

Ці labels існують тільки всередині документа або `task.context`, не як нові API fields:

```markdown
# Compact handoff

Причина нової session: ...
Попередні session/turn IDs: ...
Актуальний workspace і snapshot/coverage binding: ...
Наступна конкретна мета та acceptance criteria: ...

## Незмінні рішення й обмеження
- Рішення, коротке обґрунтування, authoritative source/version.

## Стан роботи
- Broker-observed: outcome, snapshot/delta, доступне evidence.
- Agent-reported: що заявлено, але не перевірено незалежно.
- Already performed: дії, які не можна сліпо повторювати.

## Що залишилося
- Outstanding finding IDs, невирішені питання й потрібні checks.
- Припущення та відсутні джерела/evidence.

## Джерела для нового turn
- Потрібні retained artifact IDs, source paths і snapshot references.
- Чинні bindings надасть broker; старі input paths не використовувати.

## Межі наступної дії
- Що не змінювати та що потребує окремого рішення coordinator-а.
```

Coordinator-authored summary не стає broker-observed evidence через включення до envelope. Він може допомогти знайти evidence, але не підміняє його.

### 4.3. Без нового artifact-upload API

MCP surface v0.2 не визначає загальний tool для створення/upload довільного coordinator artifact. Тому default handoff — bounded текст у наявному `task.context` плюс references на **вже створені** broker artifacts.

Якщо handoff підготував агент і реалізація вже зберегла його повідомлення/report як sealed artifact із доступним ID, цей реальний ID можна використати за чинним контрактом. Не припускати, що довільний локальний `.md` автоматично має `artifact_id`, і не додавати новий upload tool заради цього прикладу.

Надмірний handoff потрібно переглянути як task: прибрати повтори, залишити точні джерела та необхідні умови. Це явне редагування coordinator-ом до нового request, не прихована summary substitution required input broker-ом.

---

## 5. Необов’язковий read-only researcher

**Експеримент, не default етап кожної задачі.** Coordinator може доручити простішому придатному агенту пошук релевантних джерел перед дорогою реалізацією. Додатковий виклик має сенс перевіряти там, де пошук достатньо об’ємний; для дрібного fix він може лише додати витрати.

Використати звичайну session лише тоді, коли роль `researcher` і відповідний read-only profile фактично підтримані та перевірені в поточній реалізації. Цей варіант описаний у [BASE, §8.1], але його наявність у коді тут не встановлена. Якщо підтримки немає, відкласти експеримент, а не додавати нову роль чи capability в цьому пакеті. Не створювати router role, privileged context service або вкладену swarm.

**Task researcher-а:** знайти contracts, symbols, callers, залежні тести та обмеження; повернути коротку source map із version/snapshot binding, стислий виклад і явні gaps. Не обирати provider за coordinator-а, не змінювати policy/source і не створювати broker sessions.

**Delivery:** coordinator може передати короткий виклад у `task.context` із зазначенням походження. Якщо існує sealed report artifact, використати його ID. Потрібний original source лишається доступним через дозволений workspace/snapshot/input channel; researcher не є єдиним фільтром істини.

Якщо researcher працював із `current + read_only`, його lease та source precondition лишаються чинними: writer того самого workspace не запускається паралельно всупереч §8.4. Якщо source змінився після дослідження, source map є historical input, а не описом автоматично актуального стану.

Mock test може підтвердити доставку source map й оригінальних inputs. Він не доводить, що реальна модель вибрала достатній контекст; це окреме native/workflow спостереження з дозволом на usage.

---

## 6. Перевірка ефективності без нової billing subsystem

### 6.1. Спочатку доступне evidence

**Додати до validation report.** Використати вже наявний usage/result contract і logs, не розширювати DB/API заради показника, якого provider або coordinator host не повідомляє. Missing values позначати `unknown`/`null`, не нулем. [BASE, §11.4]

У локальному звіті розділяти:

| Показник | Правило інтерпретації |
|---|---|
| Прийняті task chains і quality gaps | Acceptance — рішення coordinator-а/людини, не просто execution `SUCCEEDED` |
| Attempts і fix cycles | Включати також невдалі спроби, а не лише останній успішний turn |
| End-to-end latency | Явно визначити межі вимірювання, включно з підготовкою та review |
| Native conversation starts | Показник churn, не самостійний доказ економії |
| Input/output/cached usage | Використовувати перевірені counter semantics; cumulative не додавати як delta |
| Coordinator, researcher і handoff usage | Враховувати де доступно; невідомі частини називати явно |
| Розмір MCP context/output | Bytes не називати точними model tokens або вартістю |
| Грошові витрати | Відокремити підтверджену оплату, оцінку API cost і квоту підписки |

Цільова одиниця порівняння — **повна прийнята task chain**, а не один дешевий worker call. Для сумісного й підтвердженого обліку вартість можна описати так:

```text
Вартість на одну прийняту chain =
усі враховані витрати порівнюваної серії, включно з невдалими attempts
/
кількість прийнятих chains у цій серії
```

Формулу застосовувати лише з явно визначеним billing basis та покриттям. Невідомі coordinator costs не приховувати: worker-only subtotal не називати повною вартістю. За нуля прийнятих chains показати нуль успіхів і сумарні відомі витрати; середня вартість прийнятого результату не визначена.

### 6.2. Порівняння context strategies

Повторно використати три режими [BASE, §19], не створювати четвертий обов’язковий orchestration engine:

1. Fresh native session на кожен task.
2. Persistent worker і окрема persistent reviewer session для пов’язаної chain.
3. Fresh session із explicit compact handoff coordinator-а.

Фіксувати однакові task chains, початковий source, acceptance criteria, ролі, model/effort/profile та review scope. Конкретний порядок створення reviewer sessions у кожному режимі описати заздалегідь, щоб не приховати різницю у review cost. Використовувати окремі безпечні fixtures/workspaces: один режим не має успадковувати готові виправлення іншого.

Чергувати порядок режимів і повторювати серії в межах погодженого usage budget. Фіксувати native compaction/cache observations, коли вони доступні; невідоме не домислювати. Не змінювати водночас context strategy, model і effort та не приписувати всю різницю reuse. Порівняння моделей або додаткового researcher-а — окремий наступний експеримент.

Перевагу визнавати лише в межах перевірених задач і спостережуваних метрик. Менший input при гіршій correctness або більшій кількості fix cycles не є достатнім результатом. Не вводити target «10–20×» або обіцянку повного зникнення limits.

### 6.3. Дозвіл на native runs

Default інтеграція цього додатка **не запускає реальні model calls**. Використати наявні результати або підготувати protocol зі статусом `not_run`. Нові native trials дозволені лише в межах чинної явної згоди на providers/profiles і usage; загальне прохання додати guide не вважати необмеженим дозволом витрачати квоти.

Якщо даних мало, завершити звіт висновком «недостатньо даних для вибору ефективнішого режиму». Це не блокує документаційний пакет і не виправдовує автоматичний запуск додаткових серій.

---

## 7. Порядок виконання агентом після поточної v0.2

### D0 — зафіксувати завершений baseline та зробити вузьке зіставлення

Прочитати чинну специфікацію, handoff попереднього етапу, ADR, API schemas, coordinator examples та релевантні test results. Зафіксувати commit/reference і dirty state, не створюючи commit, stash або reset без відповідного дозволу. Не повертатися до P0 з нуля, якщо немає нової конкретної підстави.

Створити коротку таблицю відповідності CE-01…CE-06: `наявне`, `потрібна документація`, `потрібна перевірка`, `дефект v0.2`, `поза scope`; для кожного — file/test/evidence reference або явне `unknown`.

Якщо виявлено safety/invariant defect базової реалізації, показати його severity та failure scenario окремо. Не приховувати його, але й не перетворювати на непогоджений runtime refactor під назвою «оптимізація контексту».

**Результат D0:** відомо, що справді потрібно додати, і немає дублювання вже завершеної роботи.

### D1 — доповнити coordinator documentation

Додати або розширити наявний guide правилами CE-01…CE-06, task/handoff templates, safe fresh-session recipe та межами необов’язкового researcher workflow. Використовувати лише реальні advertised tools і чинні schemas.

Не перезаписувати глобальні `AGENTS.md`/`CLAUDE.md` і прийняті project instructions новим універсальним prompt. За потреби додати узгоджене локальне посилання на guide, зберігши попередній зміст та ієрархію інструкцій.

**Результат D1:** coordinator може використовувати рекомендації через v0.2 без нових permissions або protocol fields.

### D2 — перевірити приклади та існуючі гарантії

Використати наявні schema checks, mock tests і релевантне regression evidence. Нові tests додавати в поточну test infrastructure тільки для справді непокритого сценарію; не створювати нову platform чи fake production features для проходження прикладу.

Якщо приклад потребує непідтримуваної операції, спочатку виправити recipe або описати limitation. Не розширювати runtime, щоб документаційна ідея виглядала реалізованою.

**Результат D2:** syntactic/schema compatibility перевірена де можливо; native та поведінкові твердження мають чесний verification status.

### D3 — підготувати або використати benchmark evidence

Зіставити наявні результати §19 з §6 додатка. Якщо реальних вимірювань немає, достатньо узгодженого protocol і `not_run`. Native runs — лише за вже чинним конкретним дозволом або окремим погодженням; їх відсутність не блокує D0–D2.

**Результат D3:** зрозуміло, що виміряно, що невідомо і які наступні experiments мають сенс, без наперед заданого переможця.

### 7.1. Очікувані deliverables

Шляхи нижче рекомендовані, не обов’язкова нова структура. Якщо repository вже має відповідні документи, доповнити їх замість дублювання.

```text
docs/coordinator-efficiency-guide.md
    CE-01…CE-06, bounded-task і handoff templates,
    явний вибір виконавця та optional researcher recipe.

docs/validation/post-v0.2-efficiency-check.md
    Baseline/ADR references, gap mapping, перевірки,
    фактичні результати або not_run, відомі limitations.
```

Наявний benchmark document можна використати без створення третього файла. Приклади можуть лишатися всередині guide. Для повністю сумісної реалізації достатньо документаційного diff без змін `src/`, migrations або package dependencies.

---

## 8. Перевірки додатка та критерії завершення

Наступні `AD-Cxx` — перевірки цього пакета. Вони **не перейменовують і не замінюють A01–A53**. Переважно це documentation/schema review та повторне використання вже наявного evidence, не вимога дублювати весь test suite.

| ID | Що перевірити | Достатнє evidence / база |
|---|---|---|
| AD-C01 | Приклади використовують тільки v0.2 tools/fields, а handoff labels не стали API properties | Schema validation прикладів у наявній infrastructure; review diff; §10 |
| AD-C02 | Bounded task не змінює coverage і не пропускає required artifacts | Guide/examples review; наявні A34–A39 та input/coverage fixtures |
| AD-C03 | Новий turn отримує свіжі input bindings; старі paths/expired IDs не стають valid через summary | §7.1.1, §15.3; наявні A35, A49, A50; native status збережено окремо |
| AD-C04 | Handoff описаний як нова conversation, без зміни immutable config старої; worktree не видається за копію dirty source | Recipe review; §5.2, §8.3, §13.2; доступне continuity evidence |
| AD-C05 | Rate/quota error, `UNKNOWN` або missing history не запускають прихований fallback/retry | Без змін базових guards; наявні A11, A17–A18, A24, A44 |
| AD-C06 | Researcher не має broker tools; summary лишається claim; original sources залишаються доступними в дозволених межах | Profile/guide review; input fixtures; якість відбору не оголошена доведеною mock-ом |
| AD-C07 | Usage не має double counting; unknown не перетворено на zero; API estimates не названо реальною оплатою підписки | §11.4, §19; наявний A26 та перевірка локального report |
| AD-C08 | Не з’явилися runtime router, memory DB, auto reset, новий upload API чи підміна обов’язкових inputs | Diff/dependency/schema review; відсутність scope expansion |

**Пакет завершений, коли:** baseline зіставлено; guide і приклади готові; можливі без inference перевірки виконані або мають конкретну причину неможливості; знайдені defects/limitations не приховані; фінальний звіт відділяє виконане від pending/native/not_run.

Passing mock/schema checks не означає доведену поведінку реальних моделей, native enforcement або фактичну економію. Неперевірені частини мають лишатися неперевіреними, навіть якщо документаційний пакет завершено.

---

## 9. Готова інструкція агенту для застосування додатка

> Поточну ітерацію за специфікацією MVP v0.2 завершено. Тепер застосуй додаток AD-01 як окремий, переважно документаційний follow-up. Не переписуй план v0.2 і не починай її реалізацію заново.
>
> Спочатку прочитай актуальну реалізацію, accepted ADR, schemas і результати тестів у межах рекомендацій додатка. Не вважай пропозиції новими features, якщо потрібні контракти вже реалізовані. Зафіксуй baseline та короткий gap mapping.
>
> Основна робота: coordinator efficiency guide, bounded-task template, explicit compact-handoff recipe, необов’язковий read-only researcher workflow і звіт про перевірки. Використовуй лише чинний API `0.2`, зберігай required artifact delivery, snapshot coverage, immutable session configuration, evidence attribution та recovery invariants.
>
> Не додавай LLM router, semantic memory, automatic retry/fallback, API billing backend, native-history reset або нові MCP tools. Не виконуй непогоджених destructive Git operations. Не змінюй runtime тільки для підтримки красивішого прикладу. Реальні defects v0.2 покажи окремо з evidence та мінімальним запропонованим виправленням.
>
> Переважно використовуй наявні schema/mock tests. Нові native calls і benchmarks запускай лише в межах конкретної явної згоди на usage; інакше залиш protocol та статус `not_run`, завершивши доступну документаційну роботу.
>
> У фіналі вкажи змінені файли, виконані перевірки, невиконані перевірки та їх причини, deviations/defects і факт наявності або відсутності runtime/API changes. Не заявляй економію токенів або грошей без відповідних вимірювань.

---

**Очікуваний результат AD-01:** завершена реалізація v0.2 отримує зрозумілі правила ефективного використання. Coordinator передає точні tasks, читає потрібне evidence, обґрунтовано повторно використовує sessions і за потреби робить явний handoff — без появи другого прихованого orchestration layer у broker-і.
