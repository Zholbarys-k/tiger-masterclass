"""Проверки API на временной базе без изменения данных мероприятия."""
from __future__ import annotations

import io
import tempfile
import unittest
from pathlib import Path

from backend import create_app
from backend.auth import create_token
from backend.db import db
from backend.models import Attachment, Question, Quiz, Submission, Task, Team, User
from backend.quiz_engine import start
from config import Config


class ApiRegressionTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        class TestConfig(Config):
            TESTING = True
            AUTO_SEED = False
            SQLALCHEMY_DATABASE_URI = f"sqlite:///{self.temp.name}/test.db"
        self.app = create_app(TestConfig)
        self.app.config['UPLOAD_DIR'] = Path(self.temp.name) / 'uploads'
        self.context = self.app.app_context()
        self.context.push()
        team = Team(number=1, name='Test team')
        db.session.add(team)
        db.session.flush()
        self.leader = User(login='test-leader', role='leader', team_id=team.id)
        self.member = User(login='test-member', role='member', team_id=team.id)
        self.admin = User(login='test-admin', role='admin')
        db.session.add_all([self.leader, self.member, self.admin])
        db.session.flush()
        self.headers = {'Authorization': f'Bearer {create_token(self.leader).token}'}
        self.member_headers = {'Authorization': f'Bearer {create_token(self.member).token}'}
        self.admin_headers = {'Authorization': f'Bearer {create_token(self.admin).token}'}
        self.task = Task(order=1, title_ru='Test', is_published=True)
        db.session.add(self.task)
        db.session.commit()
        self.client = self.app.test_client()

    def tearDown(self) -> None:
        db.session.remove()
        db.engine.dispose()
        self.context.pop()
        self.temp.cleanup()

    def test_invalid_json_returns_400(self) -> None:
        for payload in ([1], 'text', 1, {'login': 123}, {'password': []}):
            response = self.client.post('/api/auth/login', json=payload)
            self.assertEqual(response.status_code, 400)
            self.assertFalse(response.json['ok'])
        for payload in ({'school': []}, {'about': 123}):
            response = self.client.patch('/api/auth/profile', json=payload, headers=self.headers)
            self.assertEqual(response.status_code, 400)
        response = self.client.post('/api/votes', json={'section_id': [1]}, headers=self.headers)
        self.assertEqual(response.status_code, 400)

        response = self.client.patch(f'/api/admin/tasks/{self.task.id}', json={'allow_files': 'false'}, headers=self.admin_headers)
        self.assertEqual(response.status_code, 400)
        self.assertTrue(self.task.allow_files)
        # Set up a quiz so timing validation is reached.
        db.session.add(Quiz())
        db.session.commit()
        response = self.client.post('/api/admin/quiz/settings', json={'question_seconds': 'oops'}, headers=self.admin_headers)
        self.assertEqual(response.status_code, 400)

    def test_file_size_boundary(self) -> None:
        from werkzeug.datastructures import FileStorage
        from backend.utils import validate_file

        limit = self.app.config['MAX_FILE_SIZE']
        for size, valid in ((0, False), (limit, True), (limit + 1, False)):
            storage = FileStorage(stream=io.BytesIO(b'x' * size), filename='test.png', content_type='image/png')
            self.assertEqual(validate_file(storage)[0], valid)
            storage.close()

    def test_file_validation_and_permissions(self) -> None:
        path = f'/api/tasks/{self.task.id}/submit'
        response = self.client.post(path, data={'text': 'answer'}, headers=self.member_headers)
        self.assertEqual(response.status_code, 403)
        response = self.client.post(path, data={'files': (io.BytesIO(b'fake'), 'test.png', 'text/plain')}, headers=self.headers)
        self.assertEqual(response.status_code, 400)
        submission = Submission(task_id=self.task.id, team_id=self.leader.team_id, user_id=self.leader.id, text='answer')
        db.session.add(submission)
        db.session.flush()
        for i in range(5):
            db.session.add(Attachment(submission_id=submission.id, stored_name=f'{i}.png', original_name=f'{i}.png', mime='image/png', size_bytes=1))
        db.session.commit()
        response = self.client.post(path, data={'files': (io.BytesIO(b'image'), 'extra.png', 'image/png')}, headers=self.headers)
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json['error'], 'too_many_files')
        self.task.allow_files = False
        db.session.commit()
        response = self.client.post(path, data={'files': (io.BytesIO(b'image'), 'extra.png', 'image/png')}, headers=self.headers)
        self.assertEqual(response.json['error'], 'files_disabled')

    def test_quiz_result_is_hidden_until_standings(self) -> None:
        quiz = Quiz(show_results=True)
        db.session.add(quiz)
        db.session.flush()
        question = Question(quiz_id=quiz.id, order=1, text_ru='Test?', options_ru='["A", "B"]', correct_index=0, points=10)
        db.session.add(question)
        db.session.commit()
        start(quiz)
        response = self.client.post('/api/quiz/answer', json={'selected_index': 0}, headers=self.headers)
        self.assertEqual(response.status_code, 409)
        response = self.client.post('/api/quiz/answer', json={'question_id': question.id, 'selected_index': 0}, headers=self.headers)
        self.assertEqual(response.status_code, 200)
        self.assertNotIn('stats', response.json)
        state = self.client.get('/api/quiz/state', headers=self.headers).json
        self.assertIsNone(state['question']['my_answer']['is_correct'])
        self.assertIsNone(state['question']['my_answer']['points'])
        from backend.quiz_engine import reveal
        reveal(quiz)
        state = self.client.get('/api/quiz/state', headers=self.headers).json
        self.assertTrue(state['question']['my_answer']['is_correct'])
        self.assertEqual(state['question']['my_answer']['points'], 10)
        quiz.show_results = False
        db.session.commit()
        state = self.client.get('/api/quiz/state', headers=self.headers).json
        self.assertNotIn('correct_index', state['question'])
        self.assertIsNone(state['question']['my_answer']['is_correct'])

    def test_api_errors_are_json(self) -> None:
        for method, path, status in [('get', '/api/unknown', 404), ('delete', '/api/auth/login', 405)]:
            response = getattr(self.client, method)(path)
            self.assertEqual(response.status_code, status)
            self.assertFalse(response.json['ok'])


if __name__ == '__main__':
    unittest.main()
