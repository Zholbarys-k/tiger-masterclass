"""Сквозная проверка API: роли, права, задания, тест, голосование, рейтинг.

Требуется запущенный сервер: python run.py
Запуск: python scripts/smoke_test.py
"""
from __future__ import annotations

import json
import sys
import time
import urllib.error
import urllib.request
import uuid

BASE = "http://127.0.0.1:5000"
PARTICIPANT_PWD = "BEKTUROV2026"
ADMIN_PWD = "TIGERADMIN2026"

passed = 0
failed = 0


def check(label: str, condition: bool, extra: str = "") -> None:
    global passed, failed
    if condition:
        passed += 1
        print(f"  [OK]   {label}")
    else:
        failed += 1
        print(f"  [FAIL] {label} {extra}")


def call(method: str, path: str, token: str | None = None, payload=None, body=None,
         content_type: str | None = None):
    """Вернуть (status, data)."""
    url = f"{BASE}{path}"
    data = body
    headers = {}
    if payload is not None:
        data = json.dumps(payload).encode("utf-8")
        headers["Content-Type"] = "application/json"
    if content_type:
        headers["Content-Type"] = content_type
    if token:
        headers["Authorization"] = f"Bearer {token}"

    request = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(request) as response:
            return response.status, json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        raw = error.read().decode("utf-8", errors="replace")
        try:
            return error.code, json.loads(raw)
        except json.JSONDecodeError:
            return error.code, {"raw": raw[:200]}
    except urllib.error.URLError as error:
        print(f"Сервер недоступен ({error}). Запустите: python run.py")
        sys.exit(1)


def multipart(fields: dict[str, str], files: list[tuple[str, str, bytes, str]]):
    """Собрать multipart/form-data. files: (field, filename, content, mime)."""
    boundary = f"----tiger{uuid.uuid4().hex}"
    parts: list[bytes] = []
    for name, value in fields.items():
        parts.append(
            f"--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"\r\n\r\n{value}\r\n".encode()
        )
    for name, filename, blob, mime in files:
        parts.append(
            f"--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"; "
            f"filename=\"{filename}\"\r\nContent-Type: {mime}\r\n\r\n".encode()
        )
        parts.append(blob)
        parts.append(b"\r\n")
    parts.append(f"--{boundary}--\r\n".encode())
    return b"".join(parts), f"multipart/form-data; boundary={boundary}"


PNG = bytes.fromhex(
    "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4"
    "890000000a49444154789c6300010000050001od0a2db40000000049454e44ae426082"
    .replace("od", "0d")
)


def login(user: str, password: str):
    status, data = call("POST", "/api/auth/login", payload={"login": user, "password": password})
    return status, data


def main() -> None:
    print("\n=== 1. Авторизация ===")
    status, admin = login("admin01", ADMIN_PWD)
    check("админ входит с админским паролем", status == 200 and admin.get("ok"))
    check("админ получает redirect /admin", admin.get("redirect") == "/admin")
    admin_token = admin.get("token")

    status, leader = login("t01-leader", PARTICIPANT_PWD)
    check("лидер входит с общим паролем", status == 200)
    check("роль лидера определена по логину", leader["user"]["role"] == "leader")
    leader_token = leader["token"]

    status, member = login("t01-p1", PARTICIPANT_PWD)
    check("участник входит", status == 200)
    check("роль участника определена по логину", member["user"]["role"] == "member")
    member_token = member["token"]

    status, _ = login("t01-leader", ADMIN_PWD)
    check("лидер НЕ входит с админским паролем", status == 401)
    status, _ = login("admin01", PARTICIPANT_PWD)
    check("админ НЕ входит с паролем участников", status == 401)
    status, _ = login("t01-leader", "wrong")
    check("неверный пароль отклонён", status == 401)
    status, _ = login("nosuchuser", PARTICIPANT_PWD)
    check("несуществующий логин отклонён", status == 401)
    status, _ = call("GET", "/api/tasks")
    check("без токена доступ запрещён", status == 401)

    print("\n=== 2. Команда и состав ===")
    status, me = call("GET", "/api/auth/me", leader_token)
    team = me["team"]
    check("у лидера есть команда", team is not None)
    check("в команде 24 участника + лидер", len(team["members"]) == 24 and team["leader"] is not None)
    check("название команды «1-команда»", team["name"] == "1-команда")
    team_id = team["id"]

    print("\n=== 3. Задания и отправка ответов ===")
    status, tasks = call("GET", "/api/tasks", leader_token)
    check("задания загружаются", status == 200 and len(tasks["tasks"]) >= 3)
    check("лидер может отправлять", tasks["can_submit"] is True)
    task_id = tasks["tasks"][0]["id"]

    status, member_tasks = call("GET", "/api/tasks", member_token)
    check("участник видит задания", status == 200 and len(member_tasks["tasks"]) >= 3)
    check("участник не может отправлять", member_tasks["can_submit"] is False)

    body, ctype = multipart({"text": "Наш ответ команды"}, [("files", "photo.png", PNG, "image/png")])
    status, result = call("POST", f"/api/tasks/{task_id}/submit", leader_token, body=body, content_type=ctype)
    check("лидер отправил ответ с фото", status == 200 and result.get("ok"), str(result)[:120])
    submission_id = result["submission"]["id"] if status == 200 else None
    check("вложение сохранено", bool(submission_id) and len(result["submission"]["attachments"]) == 1)

    status, denied = call("POST", f"/api/tasks/{task_id}/submit", member_token, body=body, content_type=ctype)
    check("участник НЕ может отправлять ответ (403)", status == 403)

    big = b"\x00" * (16 * 1024 * 1024 + 2048)
    body_big, ctype_big = multipart({"text": "big"}, [("files", "big.mp4", big, "video/mp4")])
    status, _ = call("POST", f"/api/tasks/{task_id}/submit", leader_token, body=body_big, content_type=ctype_big)
    check("файл больше 15 МБ принят (лимита на ответы нет)", status == 200)

    body_bad, ctype_bad = multipart({"text": "bad"}, [("files", "doc.pdf", b"%PDF-1.4", "application/pdf")])
    status, _ = call("POST", f"/api/tasks/{task_id}/submit", leader_token, body=body_bad, content_type=ctype_bad)
    check("PDF отклонён (только фото/видео)", status == 400)

    status, files_member = call("GET", f"/api/files/{submission_id}/x", member_token)
    check("файл своей команды доступен участнику (404 на имя, не 403)", status == 404)

    print("\n=== 4. Тест: один вопрос на всех, таймер, рейтинг ===")
    call("POST", "/api/admin/quiz/toggle", admin_token, payload={"is_open": False})
    status, quiz = call("GET", "/api/quiz/state", leader_token)
    check("закрытый тест участникам недоступен",
          quiz["quiz"]["is_open"] is False and quiz["quiz"]["phase"] == "idle")

    status, _ = call("POST", "/api/admin/quiz/toggle", admin_token, payload={"is_open": True})
    check("админ открыл тест", status == 200)

    status, quiz = call("GET", "/api/quiz/state", leader_token)
    check("до старта вопросов не видно", quiz["quiz"]["phase"] == "idle" and quiz["question"] is None)

    status, settings = call("POST", "/api/admin/quiz/settings", admin_token,
                            payload={"question_seconds": 5, "standings_seconds": 5,
                                     "auto_advance": True})
    check("админ изменил время на вопрос и на рейтинг",
          status == 200 and settings["quiz"]["question_seconds"] == 5
          and settings["quiz"]["standings_seconds"] == 5)

    status, started = call("POST", "/api/admin/quiz/control", admin_token,
                           payload={"action": "start", "reset_answers": True})
    check("админ запустил тест", status == 200 and started["quiz"]["phase"] == "question")

    status, admin_q = call("GET", "/api/admin/quiz/questions", admin_token)
    check("в тесте не меньше 17 вопросов", len(admin_q["questions"]) >= 17)
    correct_map = {q["id"]: q["correct_index"] for q in admin_q["questions"]}

    status, q_leader = call("GET", "/api/quiz/state", leader_token)
    status, q_member = call("GET", "/api/quiz/state", member_token)
    check("выдаётся ровно один текущий вопрос", q_leader["question"]["number"] == 1)
    check("у лидера и участника один и тот же вопрос",
          q_leader["question"]["id"] == q_member["question"]["id"])
    check("участник видит варианты ответов", len(q_member["question"]["options"]) == 4)
    check("лидер может отвечать", q_leader["can_answer"] is True)
    check("участник тоже может отвечать", q_member["can_answer"] is True)
    check("правильный ответ скрыт до конца таймера", "correct_index" not in q_leader["question"])
    check("таймер идёт", 0 < (q_leader["quiz"]["remaining_seconds"] or 0) <= 5,
          str(q_leader["quiz"]["remaining_seconds"]))

    first_id = q_leader["question"]["id"]
    status, answer = call("POST", "/api/quiz/answer", leader_token,
                          payload={"question_id": first_id, "selected_index": correct_map[first_id]})
    check("ответ лидера принят", status == 200 and answer.get("accepted") is True, str(answer)[:120])
    check("результат не раскрывается до конца вопроса", "is_correct" not in answer)

    status, again = call("POST", "/api/quiz/answer", leader_token,
                         payload={"question_id": first_id, "selected_index": 0})
    check("повторный ответ отклонён", status == 400 and again.get("error") == "already_answered")

    status, denied = call("POST", "/api/quiz/answer", member_token,
                          payload={"question_id": first_id, "selected_index": 0})
    check("участник ответил на тест (неверно)", status == 200)
    status, q_member_after = call("GET", "/api/quiz/state", member_token)
    check("ответ участника не мешает ответу лидера", q_member_after["question"]["answered"] is True)

    status, waiting = call("GET", "/api/quiz/state", leader_token)
    check("ответивший ждёт остальных", waiting["can_answer"] is False
          and waiting["question"]["answered"] is True)

    status, extended = call("POST", "/api/admin/quiz/control", admin_token,
                            payload={"action": "extend", "seconds": 20})
    check("админ добавил время на ходу", status == 200
          and (extended["quiz"]["remaining_seconds"] or 0) > 5)

    status, revealed = call("POST", "/api/admin/quiz/control", admin_token,
                            payload={"action": "reveal"})
    check("админ досрочно показал рейтинг", status == 200
          and revealed["quiz"]["phase"] == "standings")

    status, q_leader = call("GET", "/api/quiz/state", leader_token)
    status, q_member = call("GET", "/api/quiz/state", member_token)
    check("после таймера виден правильный ответ", "correct_index" in q_leader["question"])
    check("участник тоже видит правильный ответ", "correct_index" in q_member["question"])
    check("своя команда получила балл", q_leader["question"]["my_answer"]["is_correct"] is True)
    check("между вопросами показано место команды",
          q_leader["standings"]["my"]["rank"] == 1, str(q_leader["standings"])[:120])
    check("видно, сколько команд ответило",
          q_leader["question_stats"]["answered_users"] == 2)

    status, late = call("POST", "/api/quiz/answer", leader_token,
                        payload={"question_id": first_id, "selected_index": 0})
    check("вне фазы вопроса ответ отклонён", status == 409, str(late)[:120])

    print("  ... ждём автоматический переход к следующему вопросу")
    time.sleep(6)
    status, auto = call("GET", "/api/quiz/state", leader_token)
    check("следующий вопрос включился сам", auto["quiz"]["phase"] == "question"
          and auto["question"]["number"] == 2, str(auto["quiz"]["phase"]))
    check("новый вопрос — другой", auto["question"]["id"] != first_id)

    status, paused = call("POST", "/api/admin/quiz/control", admin_token, payload={"action": "pause"})
    check("админ поставил тест на паузу", status == 200 and paused["quiz"]["is_paused"] is True)
    frozen = paused["quiz"]["remaining_seconds"]
    time.sleep(2)
    status, still = call("GET", "/api/quiz/state", leader_token)
    check("на паузе таймер стоит", still["quiz"]["remaining_seconds"] == frozen)
    status, blocked = call("POST", "/api/quiz/answer", leader_token,
                           payload={"question_id": still["question"]["id"], "selected_index": 0})
    check("на паузе ответ не принимается", status == 409 and blocked.get("error") == "quiz_paused")
    status, resumed = call("POST", "/api/admin/quiz/control", admin_token, payload={"action": "resume"})
    check("админ снял паузу", status == 200 and resumed["quiz"]["is_paused"] is False)

    status, jumped = call("POST", "/api/admin/quiz/control", admin_token,
                          payload={"action": "goto", "index": 14})
    check("админ вывел всем выбранный вопрос", status == 200
          and jumped["quiz"]["current_index"] == 14)
    status, q_member = call("GET", "/api/quiz/state", member_token)
    check("участник сразу видит новый вопрос", q_member["question"]["number"] == 15)

    status, finished = call("POST", "/api/admin/quiz/control", admin_token, payload={"action": "finish"})
    check("админ завершил тест", status == 200 and finished["quiz"]["phase"] == "finished")
    status, final_state = call("GET", "/api/quiz/state", leader_token)
    check("после завершения виден итоговый рейтинг", final_state["standings"] is not None)
    check("прогресс команды сохранён", final_state["my_progress"]["answered"] == 1)

    print("\n=== 5. Карточки кабинетов ===")
    call("POST", "/api/cards/reset", admin_token)
    status, cards = call("GET", "/api/cards", member_token)
    check("6 карточек загружаются", status == 200 and len(cards["cards"]) == 6)
    check("участник не может выбирать карточку", cards["can_pick"] is False)
    check("лидер может выбирать карточку", call("GET", "/api/cards", leader_token)[1]["can_pick"] is True)

    status, denied = call("POST", "/api/cards/pick", member_token, payload={"number": 1})
    check("участник не выбирает карточку (403)", status == 403)
    status, denied = call("POST", "/api/cards/pick", admin_token, payload={"number": 1})
    check("админ не выбирает карточку (403)", status == 403)

    status, picked = call("POST", "/api/cards/pick", leader_token, payload={"number": 1})
    check("лидер выбрал карточку 1", status == 200 and picked["my_room"] == "107", str(picked)[:120])
    status, again = call("POST", "/api/cards/pick", leader_token, payload={"number": 2})
    check("вторая карточка команде недоступна", status == 409 and again.get("error") == "team_already_picked")

    status, seen = call("GET", "/api/cards", member_token)
    first = seen["cards"][0]
    check("участник видит, какая команда выбрала карточку",
          first["taken"] is True and first["team_name"] == "1-команда")
    check("участник своей команды видит кабинет", first["room"] == "107" and seen["my_room"] == "107")

    status, other_leader = call("POST", "/api/auth/login", payload={"login": "t02-leader", "password": PARTICIPANT_PWD})
    other_token = other_leader["token"]
    status, taken = call("POST", "/api/cards/pick", other_token, payload={"number": 1})
    check("занятую карточку выбрать нельзя", status == 409 and taken.get("error") == "card_taken")
    status, other_view = call("GET", "/api/cards", other_token)
    check("чужой кабинет не раскрывается", other_view["cards"][0]["room"] == "")

    status, all_votes = call("GET", "/api/votes/all", admin_token)
    check("админ видит кабинеты выбравших", status == 200
          and any(c["room"] == "107" and c["taken"] for c in all_votes["cards"]))
    status, denied = call("GET", "/api/votes/all", leader_token)
    check("лидер НЕ видит админскую сводку (403)", status == 403)
    status, denied = call("POST", "/api/cards/1/release", leader_token)
    check("лидер не освобождает карточки (403)", status == 403)
    status, hidden = call("POST", "/api/cards/visibility", admin_token, payload={"visible": False})
    check("админ скрыл карточки", status == 200 and hidden["visible"] is False)
    status, hidden_view = call("GET", "/api/cards", leader_token)
    check("лидер не видит скрытые карточки", hidden_view["cards"] == [] and hidden_view["visible"] is False)
    status, blocked = call("POST", "/api/cards/pick", other_token, payload={"number": 3})
    check("при скрытии выбор карточки закрыт (403)", status == 403 and blocked.get("error") == "cards_hidden")
    status, admin_view = call("GET", "/api/cards", admin_token)
    check("админ видит скрытые карточки", len(admin_view["cards"]) == 6)
    status, shown = call("POST", "/api/cards/visibility", leader_token, payload={"visible": True})
    check("лидер не управляет видимостью (403)", status == 403)
    call("POST", "/api/cards/visibility", admin_token, payload={"visible": True})
    status, released = call("POST", "/api/cards/reset", admin_token)
    check("админ освободил все карточки", status == 200 and released["taken_count"] == 0)

    print("\n=== 6. Рейтинг ===")
    status, board = call("GET", "/api/leaderboard", leader_token)
    check("рейтинг доступен", status == 200)
    check("в рейтинге только команды с отправками", board["total_ranked"] == 1,
          f"ranked={board['total_ranked']}")
    check("ТОП-10 задан", board["top_size"] == 10)
    check("моя команда в рейтинге", board["my_team"] is not None)

    status, admin_board = call("GET", "/api/leaderboard", admin_token)
    check("админ видит все 8 команд", admin_board["total_ranked"] == 8,
          f"ranked={admin_board['total_ranked']}")

    print("\n=== 7. Панель администратора ===")
    status, overview = call("GET", "/api/admin/overview", admin_token)
    check("сводка: 8 команд, 210 аккаунтов",
          overview["stats"]["teams"] == 8 and overview["stats"]["users"] == 210)
    check("сводка: 8 лидеров, 192 участника, 10 админов",
          overview["stats"]["leaders"] == 8 and overview["stats"]["members"] == 192
          and overview["stats"]["admins"] == 10)

    status, denied = call("GET", "/api/admin/overview", leader_token)
    check("лидер НЕ имеет доступа к админ-API (403)", status == 403)

    status, graded = call("PATCH", f"/api/admin/submissions/{submission_id}/points",
                          admin_token, payload={"points": 8})
    check("админ оценил ответ", status == 200 and graded["submission"]["points"] == 8)

    status, adjusted = call("POST", f"/api/admin/teams/{team_id}/score", admin_token,
                            payload={"delta": 5, "reason": "бонус"})
    check("админ добавил 5 бонусных баллов", status == 200 and adjusted["delta"] == 5)

    status, board2 = call("GET", "/api/leaderboard", leader_token)
    mine = board2["my_team"]
    expected = mine["task_points"] + mine["quiz_points"] + mine["bonus_points"]
    check("итог = задания + тест + бонус", mine["total_points"] == expected)
    check("баллы за задание учтены (8)", mine["task_points"] == 8)
    check("бонус учтён (5)", mine["bonus_points"] == 5)

    status, set_total = call("POST", f"/api/admin/teams/{team_id}/score", admin_token,
                            payload={"set_total": 100, "reason": "выравнивание"})
    check("админ установил итог 100", status == 200 and set_total["team"]["total_points"] == 100)

    # Смена лидера
    status, teams = call("GET", "/api/admin/teams", admin_token)
    team_one = next(t for t in teams["teams"] if t["id"] == team_id)
    new_leader_id = team_one["members"][0]["id"]
    old_leader_id = team_one["leader"]["id"]
    status, promoted = call("POST", f"/api/admin/teams/{team_id}/leader/{new_leader_id}", admin_token)
    check("админ сменил лидера", status == 200 and promoted["user"]["role"] == "leader")
    check("прежний лидер стал участником",
          any(m["id"] == old_leader_id and m["role"] == "member" for m in promoted["team"]["members"]))
    call("POST", f"/api/admin/teams/{team_id}/leader/{old_leader_id}", admin_token)

    # Перенос участника
    status, teams = call("GET", "/api/admin/teams", admin_token)
    team_two = next(t for t in teams["teams"] if t["number"] == 2)
    moving = next(t for t in teams["teams"] if t["id"] == team_id)["members"][0]
    status, moved = call("POST", f"/api/admin/users/{moving['id']}/move/{team_two['id']}", admin_token)
    check("админ перенёс участника в другую команду",
          status == 200 and moved["user"]["team_id"] == team_two["id"])
    call("POST", f"/api/admin/users/{moving['id']}/move/{team_id}", admin_token)

    # Смена логина
    status, renamed = call("PATCH", f"/api/admin/users/{moving['id']}", admin_token,
                           payload={"login": "new-login-test"})
    check("админ изменил логин участника", status == 200 and renamed["user"]["login"] == "new-login-test")
    status, relogin = login("new-login-test", PARTICIPANT_PWD)
    check("вход по новому логину работает", relogin.get("ok") is True)
    status, clash = call("PATCH", f"/api/admin/users/{moving['id']}", admin_token,
                         payload={"login": "admin01"})
    check("занятый логин отклонён", status == 400)
    call("PATCH", f"/api/admin/users/{moving['id']}", admin_token, payload={"login": moving["login"]})

    # Задания
    status, created = call("POST", "/api/admin/tasks", admin_token, payload={
        "title_ru": "Тестовое задание", "title_en": "Test task", "title_kk": "Сынақ тапсырмасы",
        "body_ru": "Описание", "max_points": 20, "is_published": True,
    })
    check("админ создал задание", status == 200 and created["task"]["max_points"] == 20)
    new_task_id = created["task"]["id"]
    status, updated = call("PATCH", f"/api/admin/tasks/{new_task_id}", admin_token,
                           payload={"is_published": False})
    check("админ снял задание с публикации", status == 200 and updated["task"]["is_published"] is False)
    status, tasks_leader = call("GET", "/api/tasks", leader_token)
    check("неопубликованное задание скрыто от лидера",
          all(t["id"] != new_task_id for t in tasks_leader["tasks"]))
    status, _ = call("DELETE", f"/api/admin/tasks/{new_task_id}", admin_token)
    check("админ удалил задание", status == 200)

    print("\n=== 8. Реальное время (версии состояния) ===")
    status, state1 = call("GET", "/api/state", leader_token)
    check("эндпоинт /api/state работает", status == 200 and "versions" in state1)
    call("POST", f"/api/admin/teams/{team_id}/score", admin_token, payload={"delta": 1})
    status, state2 = call("GET", "/api/state", leader_token)
    check("версия leaderboard растёт после изменения",
          state2["versions"]["leaderboard"] > state1["versions"]["leaderboard"])

    print("\n=== 9. Выход ===")
    status, _ = call("POST", "/api/auth/logout", member_token)
    check("выход выполнен", status == 200)
    status, _ = call("GET", "/api/tasks", member_token)
    check("токен отозван после выхода", status == 401)

    print("\n" + "=" * 52)
    print(f"  ИТОГО: успешно {passed}, ошибок {failed}")
    print("=" * 52)
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
