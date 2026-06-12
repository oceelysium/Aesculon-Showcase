import os
import unittest
from unittest.mock import patch
from app import app, db
from models import User

class PasswordResetTest(unittest.TestCase):
    def setUp(self):
        app.config["TESTING"] = True
        app.config["PASSWORD_RESET_DEV_LINKS"] = True
        app.config["SMTP_HOST"] = "smtp.example.com"
        app.config["SMTP_FROM_EMAIL"] = "noreply@example.com"
        with app.app_context():
            db.drop_all()
            db.create_all()
            user = User(username="ResetUser", email="reset@example.com")
            user.set_password("password123")
            db.session.add(user)
            db.session.commit()
        self.client = app.test_client()

    @patch("smtplib.SMTP")
    def test_forgot_password_sends_email(self, mock_smtp):
        response = self.client.post(
            "/api/auth/forgot-password",
            json={"email": "reset@example.com"}
        )
        self.assertEqual(response.status_code, 200)
        payload = response.get_json()
        self.assertIn("message", payload)
        # Should call SMTP
        mock_smtp.assert_called_once_with("smtp.example.com", 587, timeout=10)

if __name__ == "__main__":
    unittest.main()
