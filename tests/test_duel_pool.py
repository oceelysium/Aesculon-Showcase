import os
import tempfile
import unittest
import json

fd, database_path = tempfile.mkstemp(suffix=".db")
os.close(fd)
os.unlink(database_path)
os.environ["DATABASE_URL"] = "sqlite:///" + database_path
os.environ["SECRET_KEY"] = "test-secret"

from app import app, db, FEATURE_FLAG_DEFAULTS
from models import Question, Attempt, User, Duel, DuelParticipant

class DuelPoolTest(unittest.TestCase):
    def setUp(self):
        app.config["TESTING"] = True
        app.config["FEATURE_FLAGS"] = dict(FEATURE_FLAG_DEFAULTS)
        app.config["FEATURE_FLAGS"]["duel"] = True
        with app.app_context():
            db.drop_all()
            db.create_all()
            
            # Insert a pool of 5 questions
            for i in range(1, 6):
                db.session.add(Question(
                    question_id=f"Q{i:03d}",
                    block="Cardiology",
                    topic="Heart Failure",
                    tier="Tier 1",
                    stem=f"Stem {i}",
                    lead_in="Which is correct?",
                    option_a="Option A",
                    option_b="Option B",
                    option_c="Option C",
                    option_d="Option D",
                    option_e="Option E",
                    correct_answer="A"
                ))
            db.session.commit()

        self.client1 = app.test_client()
        self.client2 = app.test_client()

        # Register User 1
        r1 = self.client1.post("/api/auth/register", json={
            "username": "UserOne",
            "email": "user1@example.com",
            "password": "Password123!"
        })
        self.assertEqual(r1.status_code, 200)

        # Register User 2
        r2 = self.client2.post("/api/auth/register", json={
            "username": "UserTwo",
            "email": "user2@example.com",
            "password": "Password123!"
        })
        self.assertEqual(r2.status_code, 200)

    def tearDown(self):
        with app.app_context():
            db.session.remove()
            db.drop_all()
        try:
            os.unlink(database_path)
        except OSError:
            pass

    def test_duel_pool_unanswered_insufficient_questions(self):
        # User 1 attempts all 5 questions
        with app.app_context():
            user1 = User.query.filter_by(username="UserOne").first()
            questions = Question.query.all()
            for q in questions:
                db.session.add(Attempt(
                    user_id=user1.id,
                    question_id=q.id,
                    chosen_answer="A",
                    is_correct=True
                ))
            db.session.commit()

        # User 1 creates a duel with mode="unanswered" requiring 3 questions.
        # Since User 1 has attempted all 5 questions, there are 0 shared unseen questions.
        create_res = self.client1.post("/api/duels", json={
            "question_count": 5,
            "seconds_per_question": 30,
            "visibility": "public",
            "mode": "unanswered",
            "block": "Cardiology"
        })
        self.assertEqual(create_res.status_code, 201)
        duel_data = create_res.get_json()
        invite_code = duel_data["duel"]["invite_code"]

        # User 2 joins the duel
        join_res = self.client2.post(f"/api/duels/{invite_code}/join")
        self.assertEqual(join_res.status_code, 200)

        # User 1 readies
        ready1 = self.client1.post(f"/api/duels/{invite_code}/ready")
        self.assertEqual(ready1.status_code, 200)

        # User 2 readies - this should trigger the duel start and check questions.
        # Since there are 0 shared unseen questions and we need 3, this should fail with 409.
        ready2 = self.client2.post(f"/api/duels/{invite_code}/ready")
        self.assertEqual(ready2.status_code, 409)
        err_data = ready2.get_json()
        self.assertIn("error", err_data)
        self.assertIn("Only 0 shared unseen questions are available", err_data["error"])

        # Check that participants were reset to not ready
        state_res = self.client1.get(f"/api/duels/{invite_code}/state")
        self.assertEqual(state_res.status_code, 200)
        state_data = state_res.get_json()
        for participant in state_data["players"]:
            self.assertFalse(participant["ready"])

    def test_duel_pool_all_allows_already_seen_questions(self):
        # User 1 attempts all 5 questions
        with app.app_context():
            user1 = User.query.filter_by(username="UserOne").first()
            questions = Question.query.all()
            for q in questions:
                db.session.add(Attempt(
                    user_id=user1.id,
                    question_id=q.id,
                    chosen_answer="A",
                    is_correct=True
                ))
            db.session.commit()

        # User 1 creates a duel with mode="all" requiring 3 questions.
        # Even though User 1 has attempted all 5 questions, all 5 are in the pool because mode="all".
        create_res = self.client1.post("/api/duels", json={
            "question_count": 5,
            "seconds_per_question": 30,
            "visibility": "public",
            "mode": "all",
            "block": "Cardiology"
        })
        self.assertEqual(create_res.status_code, 201)
        duel_data = create_res.get_json()
        invite_code = duel_data["duel"]["invite_code"]

        # User 2 joins the duel
        join_res = self.client2.post(f"/api/duels/{invite_code}/join")
        self.assertEqual(join_res.status_code, 200)

        # User 1 readies
        ready1 = self.client1.post(f"/api/duels/{invite_code}/ready")
        self.assertEqual(ready1.status_code, 200)

        # User 2 readies - should start successfully (status code 200) and duel status becomes "active"
        ready2 = self.client2.post(f"/api/duels/{invite_code}/ready")
        self.assertEqual(ready2.status_code, 200)
        state_data = ready2.get_json()
        self.assertEqual(state_data["duel"]["status"], "active")
        
        with app.app_context():
            db_duel = Duel.query.filter_by(invite_code=invite_code).first()
            self.assertEqual(len(db_duel.questions), 5)

if __name__ == "__main__":
    unittest.main()
