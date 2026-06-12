import os
import tempfile
import unittest


fd, database_path = tempfile.mkstemp(suffix=".db")
os.close(fd)
os.unlink(database_path)
os.environ.setdefault("DATABASE_URL", "sqlite:///" + database_path)
os.environ.setdefault("SECRET_KEY", "test-secret")

from app import FEATURE_FLAG_DEFAULTS, app, db  # noqa: E402
from models import Question  # noqa: E402


class AppSmokeTest(unittest.TestCase):
    def setUp(self):
        app.config["TESTING"] = True
        app.config["FEATURE_FLAGS"] = dict(FEATURE_FLAG_DEFAULTS)
        with app.app_context():
            db.drop_all()
            db.create_all()
        self.client = app.test_client()

    def test_capabilities_expose_feature_flags(self):
        response = self.client.get("/api/capabilities")
        self.assertEqual(response.status_code, 200)
        payload = response.get_json()
        self.assertIn("features", payload)
        self.assertIn("duel", payload["features"])

    def test_duel_can_be_feature_gated(self):
        app.config["FEATURE_FLAGS"]["duel"] = False
        page = self.client.get("/duel")
        api = self.client.get("/api/duels/open")
        self.assertEqual(page.status_code, 404)
        self.assertEqual(api.status_code, 404)

    def test_duel_season_endpoint_returns_current_standings(self):
        register = self.client.post(
            "/api/auth/register",
            json={"username": "SeasonTester", "email": "season@example.com", "password": "password123"},
        )
        self.assertEqual(register.status_code, 200)
        response = self.client.get("/api/duels/season")
        self.assertEqual(response.status_code, 200)
        payload = response.get_json()
        self.assertIn("season", payload)
        self.assertIn("leaderboard", payload)
        self.assertEqual(payload["viewer"]["arena_points"], 0)

    def test_dashboard_includes_cohort_pulse(self):
        with app.app_context():
            db.session.add(
                Question(
                    question_id="Q001",
                    block="Population Health",
                    topic="Population Health",
                    tier="Tier 1",
                    stem="A public health measure is being reviewed.",
                    lead_in="Which option is correct?",
                    option_a="Correct answer",
                    option_b="Distractor",
                    option_c="Distractor",
                    option_d="Distractor",
                    option_e="Distractor",
                    correct_answer="A",
                )
            )
            db.session.commit()
        register = self.client.post(
            "/api/auth/register",
            json={"username": "PulseTester", "email": "pulse@example.com", "password": "password123"},
        )
        self.assertEqual(register.status_code, 200)
        attempt = self.client.post("/api/attempt", json={"question_id": "Q001", "chosen_answer": "A"})
        self.assertEqual(attempt.status_code, 200)
        dashboard = self.client.get("/api/dashboard")
        self.assertEqual(dashboard.status_code, 200)
        pulse = dashboard.get_json()["cohort_pulse"]
        self.assertEqual(pulse["answered_today"], 1)
        self.assertEqual(pulse["active_today"], 1)
        self.assertEqual(pulse["accuracy_today"], 100.0)

    def test_exam_mode_saves_summary_after_submit(self):
        with app.app_context():
            for index in range(1, 11):
                db.session.add(
                    Question(
                        question_id=f"Q{index:03d}",
                        block="Population Health",
                        topic="Exam Smoke",
                        tier="Tier 1",
                        stem=f"Stem {index}",
                        lead_in="Which option is correct?",
                        option_a="Correct answer",
                        option_b="Distractor",
                        option_c="Distractor",
                        option_d="Distractor",
                        option_e="Distractor",
                        correct_answer="A",
                        explanation="A. Correct answer. Explanation text.",
                    )
                )
            db.session.commit()
        register = self.client.post(
            "/api/auth/register",
            json={"username": "ExamTester", "email": "exam@example.com", "password": "password123"},
        )
        self.assertEqual(register.status_code, 200)
        created = self.client.post(
            "/api/exams",
            json={"question_count": 10, "minutes": 15, "mode": "all", "topic": "Exam Smoke"},
        )
        self.assertEqual(created.status_code, 201)
        payload = created.get_json()
        self.assertNotIn("correct_answer", payload["questions"][0])
        exam_id = payload["exam"]["id"]
        first_question = payload["questions"][0]["question_id"]
        answer = self.client.post(
            f"/api/exams/{exam_id}/answer",
            json={"question_id": first_question, "chosen_answer": "A", "time_taken_seconds": 12},
        )
        self.assertEqual(answer.status_code, 200)
        submitted = self.client.post(f"/api/exams/{exam_id}/submit")
        self.assertEqual(submitted.status_code, 200)
        summary = submitted.get_json()
        self.assertEqual(summary["exam"]["status"], "completed")
        self.assertIn("correct_answer", summary["questions"][0])
        self.assertEqual(summary["exam"]["correct_count"], 1)


if __name__ == "__main__":
    unittest.main()
