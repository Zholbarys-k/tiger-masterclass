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

Quiz(id, title_kk/ru/en, is_open, show_results, opened_at, closed_at)
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

## 6. Тестовый модуль

1. Админ жмёт «Открыть тест» → `Quiz.is_open = true`, версия `quiz` растёт.
2. Все 15 вопросов появляются одновременно у всех пользователей (лидеров и участников).
3. **Участник** видит вопросы и варианты, но элементы выбора заблокированы (`disabled`),
   сервер отклоняет их ответы с 403.
4. **Лидер** выбирает вариант и отправляет — сервер сразу возвращает
   `{ is_correct, points, team_quiz_points }`, лидер моментально видит результат.
5. Повторный ответ на тот же вопрос запрещён (UNIQUE question_id+team_id).
6. Баллы теста немедленно учитываются в рейтинге.

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
