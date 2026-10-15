# AGENTS.md — инструкции для ИИ-агентов и разработчиков

Проект: **TIGER MasterClass** — веб-приложение для проведения школьного мастер-класса
(команды, задания, тест, голосование за секции, рейтинг в реальном времени).

## 1. Стек и принципы

| Слой | Технология | Правила |
|------|-----------|---------|
| Backend | Python 3.11+, Flask, SQLAlchemy, SQLite | Только REST JSON API под `/api/*` |
| Frontend | Чистый HTML5 / CSS3 / vanilla JS (ES modules) | Без сборщиков (no webpack/vite), без фреймворков |
| БД | SQLite файл `data/tiger.db` | Схема только через `backend/models.py` |
| Файлы | Локальная папка `uploads/` | Лимит 15 МБ, только `image/*` и `video/*` |
| Языки | KZ / RU / EN | Все тексты через `frontend/i18n/*.json` |

Ключевые принципы:

1. **Mobile-first.** Сначала стили для мобильных, затем `@media (min-width: …)`.
2. **Никакого хардкода текста в UI.** Любая новая строка добавляется во все три файла
   `frontend/i18n/kk.json`, `ru.json`, `en.json` и используется через `t('key')` или `data-i18n`.
3. **Роль решает сервер.** Фронтенд скрывает кнопки, но проверка прав ОБЯЗАТЕЛЬНА
   в backend (декораторы `@require_role`).
4. **Никаких новых зависимостей** без добавления в `requirements.txt`.
5. **Никаких миграций.** Если меняется схема — удалить `data/tiger.db` и пересоздать сид.

## 2. Карта проекта

```
TIGER/
├── run.py                     # точка входа: python run.py
├── config.py                  # конфигурация (пароли, лимиты, порт)
├── requirements.txt
├── AGENTS.md / README.md / ARCHITECTURE.md
├── backend/
│   ├── __init__.py            # create_app() — фабрика Flask
│   ├── models.py              # все таблицы SQLAlchemy
│   ├── db.py                  # объект db = SQLAlchemy()
│   ├── auth.py                # токены, декораторы @require_role
│   ├── seed.py                # генерация команд/пользователей/секций/теста
│   ├── quiz_engine.py         # фазы синхронного теста: таймеры, автопереход, пульт
│   ├── team_names.py          # генератор англоязычных научных названий команд
│   ├── utils.py               # хелперы: json_ok, json_err, локализация, файлы
│   └── routes/
│       ├── auth_routes.py         # /api/auth/*
│       ├── admin_routes.py        # /api/admin/*
│       ├── task_routes.py         # /api/tasks/*, /api/submissions/*
│       ├── vote_routes.py         # /api/sections/*, /api/votes/*
│       ├── quiz_routes.py         # /api/quiz/*
│       └── leaderboard_routes.py  # /api/leaderboard, /api/state
├── frontend/
│   ├── index.html             # экран авторизации
│   ├── app.html               # рабочее место лидера/участника (SPA)
│   ├── admin.html             # панель администратора (SPA)
│   ├── css/                   # base.css, components.css, responsive.css
│   ├── js/
│   │   ├── api.js             # обёртка fetch + токен + загрузка файлов
│   │   ├── i18n.js            # переключение языков
│   │   ├── ui.js              # тосты, модалки, форматирование, escapeHtml
│   │   ├── store.js           # состояние + опрос сервера (polling)
│   │   ├── login.js, app.js, admin.js
│   │   └── views/             # tasks.js, quiz.js, voting.js, leaderboard.js, team.js
│   └── i18n/kk.json, ru.json, en.json
├── content/
│   ├── quiz_questions.json    # 15 вопросов × 3 языка
│   └── sections.json          # секции для голосования × 3 языка
├── scripts/
│   ├── init_db.py             # создать БД + сид + файлы с логинами
│   ├── reset_db.py            # полный сброс
│   ├── export_credentials.py  # перегенерировать файлы с логинами из БД
│   └── smoke_test.py          # сквозная проверка API (98 проверок, чистая БД)
├── credentials/               # ЛОГИНЫ/ПАРОЛИ (в .gitignore)
│   ├── credentials.txt        # полный список: 8 команд × 25 = 200 участников + 10 админов
│   ├── credentials.csv        # та же таблица для Excel
│   └── team_cards.txt         # карточки команд на печать
├── data/                      # SQLite (в .gitignore)
└── uploads/                   # загруженные фото/видео (в .gitignore)
```

## 3. Модель данных (кратко)

`Team` → `User` (role: admin|leader|member) → `AuthToken`
`Task` → `Submission` → `Attachment`
`Section` ← `Vote`
`Quiz` (фаза, текущий вопрос, таймеры) → `Question` ← `QuizAnswer` (от каждого участника, один на вопрос; баллы суммируются команде)
`ScoreAdjustment` — ручные правки баллов админом.

**Тест синхронный**: у всех одновременно виден один текущий вопрос (`Quiz.phase`,
`Quiz.current_index`). Фазы: `idle → question → standings → … → finished`, время фазы —
в `Quiz.phase_ends_at`. Логика переходов только в `backend/quiz_engine.py`;
маршруты вызывают `ensure_progress(quiz)` перед чтением состояния.

**Баллы команды** = сумма `Submission.points` + сумма `QuizAnswer.points` + сумма `ScoreAdjustment.delta`.

## 4. Правила доступа (обязательны к соблюдению)

| Действие | admin | leader | member |
|----------|:-----:|:------:|:------:|
| Просмотр заданий / секций / рейтинга | ✔ | ✔ | ✔ |
| Отправка ответа на задание + файлы | ✔ | ✔ | ✘ |
| Ответы на вопросы теста | ✘* | ✔ | ✔ |
| Голосование за секцию | ✘ | ✔ | ✔ |
| Изменение состава команд, лидеров | ✔ | ✘ | ✘ |
| Ручная правка баллов | ✔ | ✘ | ✘ |
| Просмотр всех ответов/файлов/голосов | ✔ | ✘ | ✘ |

\* админ не отвечает на вопросы, но управляет ходом теста: старт, показ рейтинга,
следующий/предыдущий вопрос, вывод любого вопроса всем, пауза, +/− время, тайминги.

## 5. Стандартные команды

```bash
pip install -r requirements.txt      # зависимости
python scripts/init_db.py            # создать БД, команды, 210 аккаунтов, credentials.txt
python run.py                        # запустить сервер (http://localhost:5000)
python scripts/rebuild_teams.py     # пересоздать команды (TEAMS_COUNT × TEAM_SIZE)
python scripts/smoke_test.py         # проверить API при запущенном сервере
python scripts/reset_db.py           # полный сброс данных
```

Быстрый запуск на Windows: двойной клик по `start.bat`.

## 6. Соглашения по коду

- Python: 4 пробела, snake_case, тип-хинты в новых функциях, docstring у роутов.
- JS: ES-модули, camelCase, `const`/`let`, без глобальных переменных кроме `window.TIGER`.
- CSS: переменные в `:root` (`--clr-*`, `--space-*`), классы kebab-case, БЭМ-подобно.
- Ответ API всегда: `{ "ok": true, ... }` или `{ "ok": false, "error": "code", "message": "…" }`.
- HTTP-коды: 200 ок, 400 валидация, 401 нет токена, 403 нет прав, 404 нет объекта, 413 файл велик.

## 7. Чек-лист перед завершением задачи

- [ ] Новые строки добавлены в 3 файла i18n.
- [ ] Права проверены на сервере, а не только скрыты в UI.
- [ ] Проверено на ширине 360 px и 1440 px.
- [ ] Лимит файла 15 МБ и MIME-типы соблюдены.
- [ ] `python run.py` стартует без ошибок, консоль браузера чистая.
