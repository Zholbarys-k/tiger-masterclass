# Как выложить TIGER MasterClass в интернет (Timeweb)

Важно понимать: это **не просто набор HTML-файлов**, а приложение на Python (Flask)
с базой данных. Если просто закинуть файлы в файловый менеджер обычного хостинга,
сайт не заработает — нужен тариф с поддержкой Python.

Есть три пути. Выберите один.

| Вариант | Сложность | Когда выбирать |
|---------|-----------|----------------|
| 1. Виртуальный хостинг Timeweb с Python | средняя | у вас уже есть хостинг и файловый менеджер |
| 2. Timeweb Cloud App Platform (из GitHub) | лёгкая | хотите быстро и без SSH; нужен GitHub |
| 3. VPS Timeweb Cloud | выше средней | нужен полный контроль и надёжное хранение файлов |

---

## Вариант 1. Виртуальный хостинг Timeweb (файловый менеджер)

Требуется тариф **с поддержкой Python** (Timeweb: «Хостинг для Python», версии 3.8–3.10)
и доступ по SSH — он есть в панели управления.

### Шаг 1. Загрузить файлы

1. Откройте [файловый менеджер](https://hosting.timeweb.ru/fileman).
2. Перейдите в папку вашего сайта: `/home/<логин>/<ваш-домен>/public_html`.
3. Загрузите **всё содержимое папки проекта** (можно упаковать в ZIP и распаковать
   на сервере кнопкой «Извлечь»):

```
backend/  frontend/  content/  scripts/  data/  uploads/  credentials/
config.py  main.py  index.wsgi  .htaccess  requirements.txt  run.py
```

> Папку `credentials/` с паролями лучше НЕ загружать на сервер — она нужна только вам
> локально. Файл `.htaccess` уже закрывает к ней доступ, но безопаснее не выкладывать.

### Шаг 2. Создать виртуальное окружение (SSH)

В панели Timeweb откройте «SSH-доступ» (или подключитесь через PuTTY) и выполните:

```bash
cd ~
python3 -m venv venv
source venv/bin/activate
cd ~/<ваш-домен>/public_html
pip install --upgrade pip
pip install -r requirements.txt
```

Узнайте точный путь к пакетам — он понадобится дальше:

```bash
ls -d ~/venv/lib/python*/site-packages
```

Например: `/home/c/cw12345/venv/lib/python3.10/site-packages`

### Шаг 3. Указать этот путь в `index.wsgi`

Откройте `index.wsgi` в файловом менеджере (кнопка «Редактировать») и замените строку:

```python
VENV_SITE_PACKAGES = "/home/c/CHANGE_ME/venv/lib/python3.10/site-packages"
```

на путь, полученный в шаге 2. Больше в файле менять ничего не нужно.

### Шаг 4. Права на выполнение и на запись

В SSH:

```bash
cd ~/<ваш-домен>/public_html
chmod 755 index.wsgi
chmod -R 775 data uploads
```

Папки `data` (база SQLite) и `uploads` (фото и видео команд) должны быть доступны
на запись, иначе приложение не сможет сохранять данные.

### Шаг 5. Открыть сайт

Зайдите на ваш домен. При первом открытии приложение **само** создаст базу,
40 команд, 200 участников и 10 администраторов — запускать `init_db.py` не нужно.

Логины и пароли те же, что в `credentials/credentials.txt` на вашем компьютере.

### Если появилась ошибка 500

- В панели Timeweb откройте «Логи» → `error.log` вашего сайта.
- Чаще всего причина — неверный путь в `VENV_SITE_PACKAGES` или не установленные зависимости.
- Проверьте версию Python в настройках сайта (должна совпадать с версией окружения).

---

## Вариант 2. Timeweb Cloud App Platform (самый простой)

Здесь не нужен ни SSH, ни `.htaccess` — только репозиторий на GitHub.

1. Выложите проект на GitHub (инструкция в [README](../README.md), раздел «Публикация на GitHub»).
2. В [Timeweb Cloud](https://timeweb.cloud/) откройте раздел **App Platform** → «Добавить» → тип **Backend**.
3. Подключите свой GitHub-репозиторий и выберите ветку `main`.
4. Настройки сборки:
   - Фреймворк: **Flask**, Python 3.10 или новее
   - Команда сборки: `pip install -r requirements.txt`
   - Команда запуска: `gunicorn main:app --timeout 120 --bind 0.0.0.0:80`
5. Добавьте переменные окружения (вкладка «Переменные»), чтобы задать свои пароли:

| Переменная | Значение |
|------------|----------|
| `TIGER_PARTICIPANT_PASSWORD` | `BEKTUROV2026` |
| `TIGER_ADMIN_PASSWORD` | `TIGERADMIN2026` |
| `TIGER_SECRET_KEY` | любая длинная случайная строка |

6. Нажмите «Запустить деплой». Через пару минут на вкладке «Дашборд» появится
   адрес вида `https://имя-приложения.twc1.net` — это и есть ваш сайт.
   К нему можно привязать свой домен.

**Важное ограничение:** файловая система приложения сбрасывается при каждом
передеплое, то есть база SQLite и загруженные фото/видео исчезнут. Для одного
мероприятия это приемлемо (не передеплоивайте во время проведения), но если нужно
хранить результаты долго — используйте Вариант 3 или подключите PostgreSQL
и объектное хранилище S3.

---

## Вариант 3. VPS Timeweb Cloud (надёжнее всего)

Подходит, если результаты мастер-класса должны сохраняться, а нагрузка —
200 школьников одновременно.

```bash
# на сервере Ubuntu 22.04
sudo apt update && sudo apt install -y python3-venv nginx git
git clone <ваш-репозиторий> /opt/tiger && cd /opt/tiger
python3 -m venv venv && source venv/bin/activate
pip install -r requirements.txt
python scripts/init_db.py

# systemd-сервис
sudo tee /etc/systemd/system/tiger.service >/dev/null <<'EOF'
[Unit]
Description=TIGER MasterClass
After=network.target

[Service]
WorkingDirectory=/opt/tiger
Environment="TIGER_PARTICIPANT_PASSWORD=BEKTUROV2026"
Environment="TIGER_ADMIN_PASSWORD=TIGERADMIN2026"
ExecStart=/opt/tiger/venv/bin/gunicorn main:app --workers 3 --timeout 120 --bind 127.0.0.1:8000
Restart=always

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl enable --now tiger
```

nginx (`/etc/nginx/sites-available/tiger`):

```nginx
server {
    listen 80;
    server_name ваш-домен.ru;
    client_max_body_size 16m;      # обязательно: видео до 15 МБ

    location / {
        proxy_pass http://127.0.0.1:8000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 120s;
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/tiger /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo apt install -y certbot python3-certbot-nginx && sudo certbot --nginx   # HTTPS
```

---

## Что обязательно проверить после публикации

1. **Смените пароли**, если сайт открыт всему интернету: задайте переменные окружения
   `TIGER_PARTICIPANT_PASSWORD` и `TIGER_ADMIN_PASSWORD`, затем перезапустите приложение
   и пересоздайте раздаточные файлы командой `python scripts/export_credentials.py`.
2. **Загрузка файла 15 МБ** — попробуйте отправить видео от лидера. Если приходит
   ошибка 413, увеличьте лимит: `client_max_body_size` (nginx) или
   `LimitRequestBody` (Apache, файл `.htaccess`).
3. **HTTPS** — на Timeweb бесплатный сертификат Let's Encrypt включается в панели
   в разделе «SSL-сертификаты». Без HTTPS браузеры телефонов могут блокировать камеру.
4. **Резервная копия** — перед мероприятием и после него скачайте папки
   `data/` (база) и `uploads/` (фото, видео) через файловый менеджер.

## Альтернатива без хостинга

Если мастер-класс проходит в одном кабинете, интернет вообще не нужен: запустите
`start.bat` на своём ноутбуке и раздайте детям адрес вида `http://192.168.1.62:5000`
(их телефоны должны быть в той же Wi-Fi сети). Это быстрее и надёжнее любого хостинга.
