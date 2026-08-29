"""Сквозная проверка API: роли, права, задания, тест, голосование, рейтинг.

Требуется запущенный сервер: python run.py
Запуск: python scripts/smoke_test.py
"""
from __future__ import annotations

import json
import sys
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
    check("в команде 4 участника + лидер", len(team["members"]) == 4 and team["leader"] is not None)
    check("название команды на английском", team["name"].isascii())
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

    big = b"\x00" * (15 * 1024 * 1024 + 2048)
    body_big, ctype_big = multipart({"text": "big"}, [("files", "big.mp4", big, "video/mp4")])
    status, _ = call("POST", f"/api/tasks/{task_id}/submit", leader_token, body=body_big, content_type=ctype_big)
    check("файл больше 15 МБ отклонён", status in (400, 413))

    body_bad, ctype_bad = multipart({"text": "bad"}, [("files", "doc.pdf", b"%PDF-1.4", "application/pdf")])
    status, _ = call("POST", f"/api/tasks/{task_id}/submit", leader_token, body=body_bad, content_type=ctype_bad)
    check("PDF отклонён (только фото/видео)", status == 400)

    status, files_member = call("GET", f"/api/files/{submission_id}/x", member_token)
    check("файл своей команды доступен участнику (404 на имя, не 403)", status == 404)

    print("\n=== 4. Тест (15 вопросов) ===")
    status, quiz = call("GET", "/api/quiz/state", leader_token)
    check("тест изначально закрыт", quiz["quiz"]["is_open"] is False)

    status, _ = call("POST", "/api/admin/quiz/toggle", admin_token, payload={"is_open": True})
    check("админ открыл тест", status == 200)

    status, quiz = call("GET", "/api/quiz/state", leader_token)
    check("15 вопросов появились у лидера", len(quiz["questions"]) == 15)
    check("лидер может отвечать", quiz["can_answer"] is True)

    status, quiz_member = call("GET", "/api/quiz/state", member_token)
    check("участник видит 15 вопросов", len(quiz_member["questions"]) == 15)
    check("участник видит варианты ответов", len(quiz_member["questions"][0]["options"]) == 4)
    check("участник не может отвечать", quiz_member["can_answer"] is False)
    check("правильный ответ скрыт от участника", "correct_index" not in quiz_member["questions"][0])

    status, admin_q = call("GET", "/api/admin/quiz/questions", admin_token)
    correct_map = {q["id"]: q["correct_index"] for q in admin_q["questions"]}

    first = quiz["questions"][0]
    status, answer = call("POST", "/api/quiz/answer", leader_token,
                          payload={"question_id": first["id"], "selected_index": correct_map[first["id"]]})
    check("лидер ответил верно и сразу получил результат",
          status == 200 and answer["is_correct"] is True and answer["points"] > 0, str(answer)[:120])
    check("баллы команды обновились сразу", answer["team_total"] >= answer["points"])

    status, again = call("POST", "/api/quiz/answer", leader_token,
                         payload={"question_id": first["id"], "selected_index": 0})
    check("повторный ответ на вопрос отклонён", status == 400 and again.get("error") == "already_answered")

    second = quiz["questions"][1]
    wrong = (correct_map[second["id"]] + 1) % 4
    status, answer2 = call("POST", "/api/quiz/answer", leader_token,
                           payload={"question_id": second["id"], "selected_index": wrong})
    check("неверный ответ даёт 0 баллов", status == 200 and answer2["is_correct"] is False and answer2["points"] == 0)

    status, denied = call("POST", "/api/quiz/answer", member_token,
                          payload={"question_id": quiz["questions"][2]["id"], "selected_index": 0})
    check("участник НЕ может отвечать на тест (403)", status == 403)

    status, leader_state = call("GET", "/api/quiz/state", leader_token)
    check("лидер видит правильный ответ после ответа", "correct_index" in leader_state["questions"][0])
    check("прогресс лидера: 2 ответа", leader_state["my_progress"]["answered"] == 2)

    print("\n=== 5. Голосование за секции ===")
    status, sections = call("GET", "/api/sections", member_token)
    check("секции загружаются", status == 200 and len(sections["sections"]) >= 6)
    check("участник может голосовать", sections["can_vote"] is True)
    section_id = sections["sections"][0]["id"]

    status, voted = call("POST", "/api/votes", member_token, payload={"section_id": section_id})
    check("участник проголосовал", status == 200)
    status, voted_leader = call("POST", "/api/votes", leader_token, payload={"section_id": section_id})
    check("лидер проголосовал", status == 200)

    status, revote = call("POST", "/api/votes", member_token,
                          payload={"section_id": sections["sections"][1]["id"]})
    check("голос можно изменить", status == 200)
    total = sum(s["votes"] for s in revote["sections"])
    check("один голос на пользователя (всего 2)", total == 2, f"total={total}")

    status, denied = call("POST", "/api/votes", admin_token, payload={"section_id": section_id})
    check("админ не голосует (403)", status == 403)

    status, all_votes = call("GET", "/api/votes/all", admin_token)
    check("админ видит все голоса", status == 200 and len(all_votes["votes"]) == 2)
    status, denied = call("GET", "/api/votes/all", leader_token)
    check("лидер НЕ видит список всех голосов", status == 403)

    print("\n=== 6. Рейтинг ===")
    status, board = call("GET", "/api/leaderboard", leader_token)
    check("рейтинг доступен", status == 200)
    check("в рейтинге только команды с отправками", board["total_ranked"] == 1,
          f"ranked={board['total_ranked']}")
    check("ТОП-10 задан", board["top_size"] == 10)
    check("моя команда в рейтинге", board["my_team"] is not None)

    status, admin_board = call("GET", "/api/leaderboard", admin_token)
    check("админ видит все 40 команд", admin_board["total_ranked"] == 40,
          f"ranked={admin_board['total_ranked']}")

    print("\n=== 7. Панель администратора ===")
    status, overview = call("GET", "/api/admin/overview", admin_token)
    check("сводка: 40 команд, 210 аккаунтов",
          overview["stats"]["teams"] == 40 and overview["stats"]["users"] == 210)
    check("сводка: 40 лидеров, 160 участников, 10 админов",
          overview["stats"]["leaders"] == 40 and overview["stats"]["members"] == 160
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
