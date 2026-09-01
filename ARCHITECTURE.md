# Архитектура TIGER MasterClass

## 1. Общая схема

```
┌──────────────────────────── Браузер (телефон / ПК) ────────────────────────────┐
│  index.html  →  app.html (лидер/участник)  →  admin.html (администратор)       │
│  vanilla JS ES-модули:  api.js · i18n.js · store.js · views/*                  │
│  Хранение: localStorage → { token, lang, user }                                │
└──────────────────────────────────────┬─────────────────────────────────────────┘
                       fetch JSON / multipart │  Bearer token
┌──────────────────────────────────────▼─────────────────────────────────────────┐
│                             Flask (run.py → create_app)                        │
│  Blueprints: auth · tasks · votes · quiz · leaderboard · admin                 │
│  auth.py: токены в БД, декораторы @require_auth / @require_role                │
│  utils.py: валидация файлов (15 МБ, image/*, video/*), локализация             │
└──────────────────────────────────────┬─────────────────────────────────────────┘
                                       │ SQLAlchemy ORM
┌──────────────────────────────────────▼─────────────────────────────────────────┐
│  SQLite  data/tiger.db      │      Файлы  uploads/<submission_id>/<uuid>.<ext> │
└────────────────────────────────────────────────────────────────────────────────┘
```

## 2. Реальное время

WebSocket не используется (лишняя зависимость для школьного мероприятия).
Применяется **лёгкий polling с версионированием**:

1. Каждое изменение данных инкрементирует счётчик в таблице `StateVersion`
   (ключи: `tasks`, `quiz`, `votes`, `leaderboard`, `teams`).
2. Клиент раз в 4 секунды запрашивает `GET /api/state` → `{ versions: {...}, server_time }`.
   Ответ весит ~150 байт.
3. Если версия интересующего раздела изменилась — клиент перезагружает только этот раздел.

Это даёт эффект «в реальном времени» при минимальной нагрузке и без доп. библиотек.

## 3. Аутентификация

- Один общий пароль участников: `BEKTUROV2026` (константа `PARTICIPANT_PASSWORD`).
- Один общий пароль администраторов: `TIGERADMIN2026` (константа `ADMIN_PASSWORD`).
- Роль **не вводится пользователем**, а определяется по логину (поле `User.role`).
- При успешном входе создаётся `AuthToken` (32-байтный hex), живёт `TOKEN_TTL_HOURS`.
- Токен передаётся в заголовке `Authorization: Bearer <token>`.
- Пароли в БД не хранятся в открытом виде — хранится `password_hash` (PBKDF2),
  что позволяет админу менять логины/пароли конкретных аккаунтов.

## 4. Схема БД

```
Team(id, name, slug, is_active, created_at)
 └─ User(id, login UNIQUE, display_name, role, team_id, password_hash, is_active)
     └─ AuthToken(token PK, user_id, created_at, expires_at)

Task(id, order, title_kk/ru/en, body_kk/ru/en, max_points, is_published, created_at, deadline)
 └─ Submission(id, task_id, team_id, user_id, text, points, created_at, updated_at)
     └─ Attachment(id, submission_id, stored_name, original_name, mime, size_bytes)

Section(id, code, name_kk/ru/en, desc_kk/ru/en, capacity, is_open)
 └─ Vote(id, user_id UNIQUE, section_id, created_at)     # 1 голос на пользователя, можно менять

Quiz(id, title_kk/ru/en, is_open, show_results, opened_at, closed_at,
     phase, current_index, phase_started_at, phase_ends_at,
     question_seconds, standings_seconds, auto_advance, is_paused, paused_remaining)
 └─ Question(id, quiz_id, order, text_kk/ru/en, options_kk/ru/en JSON, correct_index, points)
     └─ QuizAnswer(id, question_id, team_id, user_id, selected_index, is_correct, points)
        UNIQUE(question_id, team_id)   # одна попытка команды на вопрос

ScoreAdjustment(id, team_id, admin_id, delta, reason, created_at)
StateVersion(key PK, version, updated_at)
```

## 5. Расчёт рейтинга

```
total(team) = Σ Submission.points + Σ QuizAnswer.points + Σ ScoreAdjustment.delta
```

Правила отображения:
- Команда попадает в рейтинг, только если есть хотя бы одна отправка
  (`Submission` или `QuizAnswer`) либо ненулевая ручная правка.
- Клиент показывает **ТОП-10**, кнопка «Показать всех» раскрывает полный список.
- Сортировка: баллы ↓, затем время последней активности ↑ (кто раньше — выше).

## 6. Тестовый модуль (синхронный, один вопрос на всех)

Состояние теста живёт в четырёх фазах: `idle → question → standings → … → finished`.

1. Админ открывает тест (`Quiz.is_open`), затем жмёт «Начать тест» →
   фаза `question`, `current_index = 0`, `phase_ends_at = now + question_seconds` (по умолчанию 60 с).
2. Все участники и лидеры видят **один и тот же текущий вопрос** и один и тот же таймер.
   Клиент считает секунды локально от полученного `remaining_seconds`, поэтому расхождения
   часов на телефонах не влияют.
3. **Участник** видит вопрос и варианты, но кнопки заблокированы; сервер отклоняет его ответ (403).
   **Лидер** выбирает вариант → ответ принят (`accepted`), правильность пока не раскрывается,
   экран переходит в режим ожидания остальных команд.
4. Когда время вышло (или админ нажал «Показать рейтинг сейчас») → фаза `standings`:
   правильный ответ, свой результат, сколько команд ответило и место команды в рейтинге.
5. Через `standings_seconds` включается следующий вопрос — сразу у всех. Если
   `auto_advance = false`, переход ждёт кнопки администратора.
6. После последнего вопроса — фаза `finished` с итоговым рейтингом.
7. Повторный ответ на вопрос запрещён (UNIQUE question_id+team_id), баллы сразу идут в рейтинг.

Смена фаз не требует планировщика: `backend/quiz_engine.ensure_progress()` пересчитывает
расписание по `phase_ends_at` при каждом обращении к `/api/state` и `/api/quiz/state`,
а сам переход выполняется условным `UPDATE ... WHERE phase = ? AND current_index = ?`,
поэтому параллельные запросы сотен клиентов не могут перескочить вопрос дважды.

Пульт администратора (`POST /api/admin/quiz/control`): `start`, `reveal`, `next`, `prev`,
`goto`, `extend`, `pause`, `resume`, `finish`, `reset`.
Тайминги на ходу: `POST /api/admin/quiz/settings` (`question_seconds`, `standings_seconds`,
`auto_advance`, `show_results`) — новое время применяется и к уже идущей фазе.

## 7. Загрузка файлов

- Клиент: проверка `file.size <= 15 MB` и `type.startsWith('image/'|'video/')` до отправки.
- Сервер: `MAX_CONTENT_LENGTH = 16 MB` (запас на multipart) + повторная проверка каждого файла;
  расширение берётся из белого списка, имя генерируется через `uuid4`.
- Отдача файлов: `GET /api/files/<submission_id>/<stored_name>` только авторизованным
  (своя команда или админ).

## 8. Адаптивность

| Ширина | Раскладка |
|--------|-----------|
| < 640 px | одна колонка, нижняя навигация с крупными иконками (min 48×48 px) |
| 640–1023 px | две колонки карточек, нижняя навигация |
| ≥ 1024 px | боковое меню слева, контент до 1200 px, таблицы полной ширины |

Дополнительно: `clamp()` для типографики, `env(safe-area-inset-bottom)` для iPhone,
таблицы рейтинга превращаются в карточки на мобильных.

## 9. Безопасность (уровень школьного мероприятия)

- Токены с TTL, отзыв при logout, хранение хешей паролей.
- Все мутации проверяют роль на сервере.
- Ограничение размера тела запроса, whitelist MIME/расширений.
- Защита от подмены команды: `team_id` всегда берётся из токена, а не из запроса
  (кроме админских эндпоинтов).
