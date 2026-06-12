import json
import hmac
import os
import random
import secrets
import smtplib
from collections import defaultdict
from datetime import date, datetime, timedelta, timezone
from email.message import EmailMessage
from zoneinfo import ZoneInfo

import click
from flask import Flask, current_app, jsonify, redirect, render_template, request, session, url_for
from flask_migrate import Migrate
from sqlalchemy import and_, case, desc, distinct, func, inspect, or_, select, text
from sqlalchemy.exc import SQLAlchemyError
from itsdangerous import BadSignature, SignatureExpired, URLSafeTimedSerializer

from models import AppNotification, AppNotificationResponse, Attempt, DeletedQuestion, Duel, DuelAnswer, DuelParticipant, DuelQuestion, DuelSeasonResult, ExamAnswer, ExamQuestion, ExamSession, PatchNote, Question, QuestionFeedbackNotification, QuestionQualityVote, SiteFeedback, SpacedRepetition, User, db, question_blocks, secondary_blocks_list
from seed import ensure_question_bank_schema, register_seed_command
from sm2 import schedule_review


LEVELS = [
    ("Neophyte", "Newly arrived at the temple"),
    ("Acolyte", "Tending the sacred flame"),
    ("Scholiast", "Annotating the ancient texts"),
    ("Sophist", "Arguing in the agora"),
    ("Physician", "Serving in the healing halls"),
    ("Strategos", "Commanding the field"),
    ("Archon", "Presiding over the city"),
    ("Senator", "Deliberating in the Forum"),
    ("Praetor", "Administering the law"),
    ("Oracle", "Speaking for the gods"),
]

LEVEL_THRESHOLDS = [0, 200, 500, 900, 1400, 2050, 2850, 3800, 4900, 6200]
MAX_PUBLIC_DUEL_PLAYERS = 6
DEFAULT_CANONICAL_HOST = "aesculon.lol"
DEFAULT_LEGACY_HOSTS = {"aesculon.onrender.com"}
FEATURE_FLAG_DEFAULTS = {
    "duel": True,
    "focus_player": True,
    "site_feedback": True,
    "app_notifications": True,
    "shell_navigation": True,
}

LEVEL_REQUIREMENTS = [
    {"coverage": 0, "accuracy": 0},
    {"coverage": 5, "accuracy": 0},
    {"coverage": 12, "accuracy": 0},
    {"coverage": 20, "accuracy": 50},
    {"coverage": 30, "accuracy": 55},
    {"coverage": 42, "accuracy": 60},
    {"coverage": 55, "accuracy": 63},
    {"coverage": 70, "accuracy": 66},
    {"coverage": 82, "accuracy": 70},
    {"coverage": 90, "accuracy": 75},
]

ROMAN = {
    1: "I",
    2: "II",
    3: "III",
    4: "IV",
    5: "V",
    6: "VI",
    7: "VII",
    8: "VIII",
    9: "IX",
    10: "X",
}


def load_version_info(root_path):
    path = os.path.join(root_path, "static", "version.json")
    fallback = {
        "version": "dev",
        "announcement": {
            "active": False,
            "id": "",
            "title": "",
            "summary": "",
            "items": [],
        },
    }
    try:
        with open(path, "r", encoding="utf-8") as handle:
            data = json.load(handle)
    except (OSError, json.JSONDecodeError):
        return fallback

    announcement = data.get("announcement") if isinstance(data.get("announcement"), dict) else {}
    items = announcement.get("items") if isinstance(announcement.get("items"), list) else []
    return {
        "version": str(data.get("version") or fallback["version"]),
        "announcement": {
            "active": announcement.get("active") is True,
            "id": str(announcement.get("id") or ""),
            "title": str(announcement.get("title") or ""),
            "summary": str(announcement.get("summary") or ""),
            "items": [str(item) for item in items if str(item).strip()],
        },
    }


def create_app():
    app = Flask(__name__)
    app.config["SECRET_KEY"] = os.environ.get("SECRET_KEY", "aesculon-dev-key")
    database_url = os.environ.get("DATABASE_URL", "sqlite:///aesculon.db")
    if database_url.startswith("postgres://"):
        database_url = database_url.replace("postgres://", "postgresql://", 1)
    app.config["SQLALCHEMY_DATABASE_URI"] = database_url
    app.config["SQLALCHEMY_TRACK_MODIFICATIONS"] = False
    app.config["SESSION_COOKIE_HTTPONLY"] = True
    app.config["SESSION_COOKIE_SAMESITE"] = "Lax"
    app.config["PERMANENT_SESSION_LIFETIME"] = timedelta(days=180)
    app.config["ADMIN_EMAILS"] = admin_email_set(os.environ.get("ADMIN_EMAILS", ""))
    app.config["PASSWORD_RESET_MAX_AGE_SECONDS"] = safe_int(os.environ.get("PASSWORD_RESET_MAX_AGE_SECONDS")) or 3600
    app.config["PASSWORD_RESET_DEV_LINKS"] = truthy_env(os.environ.get("PASSWORD_RESET_DEV_LINKS")) or app.debug or app.testing
    app.config["SMTP_HOST"] = os.environ.get("SMTP_HOST", "").strip()
    app.config["SMTP_USE_SSL"] = truthy_env(os.environ.get("SMTP_USE_SSL"))
    app.config["SMTP_USE_TLS"] = not falsy_env(os.environ.get("SMTP_USE_TLS"))
    app.config["SMTP_PORT"] = safe_int(os.environ.get("SMTP_PORT")) or (465 if app.config["SMTP_USE_SSL"] else 587)
    app.config["SMTP_USERNAME"] = os.environ.get("SMTP_USERNAME", "").strip()
    app.config["SMTP_PASSWORD"] = os.environ.get("SMTP_PASSWORD", "")
    app.config["SMTP_FROM_EMAIL"] = os.environ.get("SMTP_FROM_EMAIL", "").strip()
    app.config["CANONICAL_HOST"] = os.environ.get("CANONICAL_HOST", DEFAULT_CANONICAL_HOST).strip()
    app.config["APP_TIMEZONE"] = os.environ.get("APP_TIMEZONE", "Australia/Sydney").strip() or "Australia/Sydney"
    app.config["LEGACY_HOSTS"] = {
        host.strip().lower()
        for host in os.environ.get("LEGACY_HOSTS", ",".join(DEFAULT_LEGACY_HOSTS)).split(",")
        if host.strip()
    }
    app.config["FEATURE_FLAGS"] = load_feature_flags()

    db.init_app(app)
    Migrate(app, db)
    register_seed_command(app)
    register_auth_upgrade_command(app)
    register_duel_schema_command(app)
    register_feedback_schema_command(app)
    register_exam_schema_command(app)

    @app.context_processor
    def inject_globals():
        flags = current_app.config.get("FEATURE_FLAGS", FEATURE_FLAG_DEFAULTS)
        return {
            "level_for_xp": level_for_xp,
            "roman": roman,
            "app_version": load_version_info(app.root_path),
            "feature_flags": flags,
            "feature_enabled": feature_enabled,
        }

    @app.errorhandler(SQLAlchemyError)
    def database_error(error):
        db.session.rollback()
        wants_json = request.path.startswith("/api/")
        if wants_json:
            return jsonify({"error": "The archive is temporarily unreachable."}), 503
        return render_template("maintenance.html"), 503

    @app.before_request
    def redirect_legacy_host():
        canonical_host = current_app.config.get("CANONICAL_HOST", "").strip()
        legacy_hosts = current_app.config.get("LEGACY_HOSTS", set())
        current_host = request.host.split(":", 1)[0].lower()
        if canonical_host and current_host in legacy_hosts:
            target = f"https://{canonical_host}{request.full_path}"
            if target.endswith("?"):
                target = target[:-1]
            return redirect(target, code=308)
        return None

    @app.before_request
    def enforce_feature_gates():
        if not feature_enabled("duel") and (request.path == "/duel" or request.path.startswith("/duel/") or request.path.startswith("/api/duels")):
            if request.path.startswith("/api/"):
                return jsonify({"error": "Duel mode is currently disabled."}), 404
            return render_template(
                "maintenance.html",
                page_title="Duel",
                eyebrow="The Arena rests",
                heading="Duel mode is temporarily unavailable.",
                copy="Practice, Due Review, Progress, and Leaderboard remain available.",
            ), 404
        return None

    @app.before_request
    def prepare_question_bank_schema():
        if request.endpoint == "static":
            return None
        ensure_question_bank_schema()
        return None

    @app.get("/ping")
    def ping():
        return "ok", 200

    @app.get("/api/version")
    def app_version():
        response = jsonify(load_version_info(app.root_path))
        response.headers["Cache-Control"] = "no-store, max-age=0"
        return response

    @app.get("/api/capabilities")
    def capabilities_api():
        return jsonify({"features": current_app.config.get("FEATURE_FLAGS", FEATURE_FLAG_DEFAULTS)})

    @app.get("/")
    def stoa():
        return render_template("stoa.html", page_title="Home")

    @app.get("/reset-password")
    def reset_password_page():
        return render_template("reset_password.html", page_title="Reset password", reset_token=request.args.get("token", ""))

    @app.get("/practice")
    def practice():
        return render_template("agora.html", page_title="Practice")

    @app.get("/exam")
    @app.get("/exam/<int:session_id>")
    def exam_page(session_id=None):
        return render_template("exam.html", page_title="Exam Mode", session_id=session_id or "")

    @app.get("/duel")
    @app.get("/duel/<invite_code>")
    def duel_page(invite_code=None):
        return render_template("duel.html", page_title="Duel", invite_code=invite_code or "")

    @app.get("/filter")
    def filter_page():
        return redirect(url_for("practice", filters="open"))

    @app.get("/review")
    def review_page():
        return redirect(url_for("practice", mode="due"))

    @app.get("/progress")
    def progress_page():
        return render_template("tablet.html", page_title="Progress")

    @app.get("/stats")
    def stats_page():
        return redirect(url_for("progress_page"))

    @app.get("/leaderboard")
    def leaderboard_page():
        return render_template("pantheon.html", page_title="Leaderboard", leaderboard=leaderboard_rows())

    @app.get("/admin")
    def admin_page():
        user = require_user()
        if not is_admin_user(user):
            return (
                render_template(
                    "maintenance.html",
                    page_title="Admin",
                    eyebrow="Access restricted",
                    heading="This workshop is locked.",
                    copy="Admin summaries are available only to configured admin accounts.",
                ),
                403,
            )
        return render_template("admin.html", page_title="Admin")

    @app.get("/admin/")
    def admin_page_slash():
        return redirect(url_for("admin_page"))

    @app.get("/admin/question-feedback")
    def question_feedback_page():
        user = require_user()
        if not is_admin_user(user):
            return (
                render_template(
                    "maintenance.html",
                    page_title="Question feedback",
                    eyebrow="Access restricted",
                    heading="This workshop is locked.",
                    copy="Question feedback review is available only to configured admin accounts.",
                ),
                403,
            )
        return render_template("question_feedback.html", page_title="Question feedback")

    @app.get("/admin/question-feedback/")
    def question_feedback_page_slash():
        return redirect(url_for("question_feedback_page"))

    @app.get("/admin/question-bank")
    def question_bank_page():
        user = require_user()
        if not is_admin_user(user):
            return (
                render_template(
                    "maintenance.html",
                    page_title="Question bank",
                    eyebrow="Access restricted",
                    heading="This archive shelf is locked.",
                    copy="Question-bank editing is available only to configured admin accounts.",
                ),
                403,
            )
        return render_template("question_bank.html", page_title="Question bank")

    @app.get("/admin/question-bank/")
    def question_bank_page_slash():
        return redirect(url_for("question_bank_page"))

    @app.get("/activity")
    @app.get("/admin/activity")
    def admin_activity_page():
        user = require_user()
        if not is_admin_user(user):
            return (
                render_template(
                    "maintenance.html",
                    page_title="Activity",
                    eyebrow="Access restricted",
                    heading="This workshop is locked.",
                    copy="User activity is available only to configured admin accounts.",
                ),
                403,
            )
        return render_template("admin_activity.html", page_title="Activity")

    @app.get("/activity/")
    @app.get("/admin/activity/")
    def admin_activity_page_slash():
        return redirect(url_for("admin_activity_page"))

    @app.get("/api/auth/session")
    def auth_session():
        user = current_user()
        if not user:
            return jsonify({"authenticated": False, "user": None})
        return jsonify({"authenticated": True, "user": user_payload(user)})

    @app.post("/api/auth/register")
    def register():
        data = request.get_json(silent=True) or {}
        username = clean_username(data.get("username"))
        email = clean_email(data.get("email"))
        password = str(data.get("password", ""))
        if not username:
            return jsonify({"error": "Name yourself before entering the temple."}), 400
        if not email:
            return jsonify({"error": "A valid email is required for the ledger."}), 400
        password_error = validate_password(password)
        if password_error:
            return jsonify({"error": password_error}), 400
        if User.query.filter(func.lower(User.username) == username.lower()).first():
            return jsonify({"error": "That temple name is already inscribed."}), 409
        if User.query.filter(func.lower(User.email) == email.lower()).first():
            return jsonify({"error": "That email already has a place in the ledger."}), 409

        user = User(username=username, email=email, auth_provider="native", streak_days=0, streak_shield=False, total_xp=0)
        user.set_password(password)
        db.session.add(user)
        db.session.flush()
        login_user(user)
        db.session.commit()
        return jsonify(user_payload(user))

    @app.post("/api/auth/login")
    def login():
        data = request.get_json(silent=True) or {}
        email = clean_email(data.get("email"))
        password = str(data.get("password", ""))
        user = User.query.filter(func.lower(User.email) == email.lower()).first() if email else None
        if not user or not user.check_password(password):
            return jsonify({"error": "The temple does not recognise those credentials."}), 401
        remember = data.get("remember", True)
        login_user(user, remember=bool(remember) and not falsy_env(remember))
        db.session.commit()
        return jsonify(user_payload(user))

    @app.post("/api/auth/forgot-password")
    def forgot_password():
        data = request.get_json(silent=True) or {}
        email = clean_email(data.get("email"))
        response = {"message": "If that email is in the ledger, a reset link will be sent shortly."}
        user = User.query.filter(func.lower(User.email) == email.lower()).first() if email else None
        if not user or not user.password_hash:
            return jsonify(response)
        token = create_password_reset_token(user)
        reset_url = url_for("reset_password_page", token=token, _external=True)
        sent = send_password_reset_email(user, reset_url)
        if not sent and current_app.config.get("PASSWORD_RESET_DEV_LINKS"):
            response["reset_url"] = reset_url
        return jsonify(response)

    @app.post("/api/auth/reset-password")
    def reset_password():
        data = request.get_json(silent=True) or {}
        token = str(data.get("token") or "")
        password = str(data.get("password") or "")
        password_error = validate_password(password)
        if password_error:
            return jsonify({"error": password_error}), 400
        user = verify_password_reset_token(token)
        if not user:
            return jsonify({"error": "That reset link is invalid or has expired."}), 400
        user.set_password(password)
        login_user(user)
        db.session.commit()
        return jsonify(user_payload(user))

    @app.post("/api/auth/logout")
    def logout():
        session.clear()
        return jsonify({"ok": True})

    @app.post("/api/users")
    def claim_user():
        return jsonify({"error": "Account creation now requires email and password."}), 410

    @app.get("/api/dashboard")
    @app.get("/api/dashboard/<username>")
    def dashboard(username=None):
        user = require_user()
        if not user:
            return auth_required_response()
        leaderboard = leaderboard_rows(limit=5)
        due_count = due_review_query(user).count()
        next_due = next_review_for_user(user)
        answered = Attempt.query.filter_by(user_id=user.id).count()
        stats = stats_payload(user)
        summary = stats["summary"]
        return jsonify(
            {
                "user": user_payload(user),
                "leaderboard": leaderboard,
                "due_count": due_count,
                "next_due_date": next_due.next_review_date.isoformat() if next_due else None,
                "next_due_label": "Due now" if due_count else (review_date_label(next_due.next_review_date) if next_due else "None scheduled"),
                "weakest_topic": stats["weakest_topics"][0] if stats["weakest_topics"] else None,
                "questions_answered": answered,
                "answered_unique": summary["answered_unique"],
                "total_questions": summary["total_questions"],
                "completion": summary["completion"],
                "cohort_pulse": cohort_pulse_payload(),
            }
        )

    @app.get("/api/feedback-notifications")
    def feedback_notifications_api():
        ensure_feedback_schema()
        user = require_user()
        if not user:
            return auth_required_response()
        rows = (
            QuestionFeedbackNotification.query.filter_by(user_id=user.id, read_at=None)
            .order_by(QuestionFeedbackNotification.created_at.desc())
            .limit(6)
            .all()
        )
        return jsonify({"items": [feedback_notification_payload(item) for item in rows]})

    @app.post("/api/feedback-notifications/read")
    def mark_feedback_notifications_read_api():
        ensure_feedback_schema()
        user = require_user()
        if not user:
            return auth_required_response()
        ids = request.get_json(silent=True) or {}
        raw_ids = ids.get("ids") if isinstance(ids.get("ids"), list) else []
        notification_ids = [safe_int(item) for item in raw_ids if safe_int(item)]
        query = QuestionFeedbackNotification.query.filter_by(user_id=user.id, read_at=None)
        if notification_ids:
            query = query.filter(QuestionFeedbackNotification.id.in_(notification_ids))
        now = utc_now()
        for item in query.all():
            item.read_at = now
        db.session.commit()
        return jsonify({"ok": True})

    @app.post("/api/site-feedback")
    def site_feedback_api():
        if not feature_enabled("site_feedback"):
            return jsonify({"error": "Site feedback is currently disabled."}), 404
        ensure_site_feedback_schema()
        data = request.get_json(silent=True) or {}
        message = clean_site_feedback_text(data.get("message"))
        category = clean_site_feedback_category(data.get("category"))
        page_path = clean_site_feedback_text(data.get("page_path"), limit=300)
        if not message:
            return jsonify({"error": "Write a short note before sending feedback."}), 400
        feedback = SiteFeedback(
            user=current_user(),
            category=category,
            message=message,
            page_path=page_path,
            user_agent=clean_site_feedback_text(request.headers.get("User-Agent", ""), limit=500),
        )
        db.session.add(feedback)
        db.session.commit()
        return jsonify({"ok": True, "message": "Feedback sent. Thank you."})

    @app.get("/api/notifications")
    def app_notifications_api():
        if not feature_enabled("app_notifications"):
            return jsonify({"items": []})
        ensure_app_notification_schema()
        user = require_user()
        if not user:
            return auth_required_response()
        seen_subquery = select(AppNotificationResponse.notification_id).where(AppNotificationResponse.user_id == user.id)
        rows = (
            AppNotification.query.filter(
                AppNotification.active.is_(True),
                AppNotification.id.not_in(seen_subquery),
            )
            .order_by(AppNotification.created_at.asc(), AppNotification.id.asc())
            .limit(3)
            .all()
        )
        return jsonify({"items": [app_notification_payload(item) for item in rows]})

    @app.post("/api/notifications/<int:notification_id>/respond")
    def respond_app_notification_api(notification_id):
        if not feature_enabled("app_notifications"):
            return jsonify({"error": "Notifications are currently disabled."}), 404
        ensure_app_notification_schema()
        user = require_user()
        if not user:
            return auth_required_response()
        notification = AppNotification.query.filter_by(id=notification_id, active=True).first()
        if not notification:
            return jsonify({"error": "That notification is no longer active."}), 404
        data = request.get_json(silent=True) or {}
        response = normalize_notification_response(data.get("response"))
        if not response:
            return jsonify({"error": "Choose Yes, No, or Dismiss."}), 400
        existing = AppNotificationResponse.query.filter_by(user_id=user.id, notification_id=notification.id).first()
        if existing:
            existing.response = response
        else:
            db.session.add(AppNotificationResponse(user_id=user.id, notification_id=notification.id, response=response))
        db.session.commit()
        return jsonify({"ok": True})

    @app.post("/api/attempt")
    def attempt_question():
        data = request.get_json(silent=True) or {}
        user = require_user()
        if not user:
            return auth_required_response()
        question_key = data.get("question_id")
        chosen = str(data.get("chosen_answer", "")).upper()[:1]

        if not question_key or chosen not in {"A", "B", "C", "D", "E"}:
            return jsonify({"error": "The Oracle cannot judge an incomplete answer."}), 400

        question = Question.query.filter_by(question_id=question_key).first_or_404()
        payload = record_attempt_and_awards(user, question, chosen, safe_int(data.get("time_taken_seconds")))
        db.session.commit()
        return jsonify(payload)

    @app.post("/api/question-quality")
    def question_quality_vote_api():
        ensure_feedback_schema()
        data = request.get_json(silent=True) or {}
        user = require_user()
        if not user:
            return auth_required_response()
        question_key = data.get("question_id")
        vote_value = normalize_question_quality_vote(data.get("vote"))
        if not question_key or not vote_value:
            return jsonify({"error": "Choose a valid question quality mark."}), 400
        question = Question.query.filter_by(question_id=question_key).first_or_404()
        vote = QuestionQualityVote.query.filter_by(user_id=user.id, question_id=question.id).first()
        if not vote:
            vote = QuestionQualityVote(user=user, question=question, vote=vote_value)
            db.session.add(vote)
        else:
            vote.vote = vote_value
            vote.resolved_action = None
            vote.admin_reply = None
            vote.source_anchor = None
            vote.resolved_by_user_id = None
            vote.resolved_at = None
            vote.read_at = None
        db.session.commit()
        return jsonify(
            {
                "ok": True,
                "vote": vote_value,
                "label": question_quality_label(vote_value),
                "counts": question_quality_counts(question.id),
            }
        )

    @app.get("/api/next-question")
    def next_question():
        user = require_user()
        if not user:
            return auth_required_response()
        query = filtered_questions_query(request.args)

        mode = practice_mode(request.args.get("mode"))
        if user and mode == "unanswered":
            attempted_ids = select(Attempt.question_id).where(Attempt.user_id == user.id)
            query = query.filter(~Question.id.in_(attempted_ids))
        elif user and mode == "incorrect":
            query = query.filter(Question.id.in_(latest_incorrect_question_ids(user)))
        elif user and mode == "due":
            due_ids = select(SpacedRepetition.question_id).where(
                and_(
                    SpacedRepetition.user_id == user.id,
                    SpacedRepetition.next_review_date <= date.today(),
                )
            )
            query = query.filter(Question.id.in_(due_ids))

        excluded = excluded_question_keys(request.args)
        if excluded:
            query = query.filter(~Question.question_id.in_(excluded))

        questions = query.all()
        if not questions:
            response = {"question": None, "message": "No questions match this session."}
            if excluded:
                response["message"] = "No questions remain in this session."
            if mode == "unanswered":
                response["message"] = "No new questions remain for this session." if excluded else "No new questions remain. Try Incorrect or Due Review."
            if mode == "due":
                next_due = next_review_for_user(user)
                response["message"] = "No due review questions remain in this session." if excluded else "No questions are due for review."
                response["next_due_date"] = next_due.next_review_date.isoformat() if next_due else None
            return jsonify(response), 404
        return jsonify({"question": select_next_question(questions, user, mode).to_dict()})

    @app.get("/api/leaderboard")
    def leaderboard_api():
        return jsonify({"users": leaderboard_rows()})

    @app.get("/api/stats")
    @app.get("/api/stats/<username>")
    def stats_api(username=None):
        user = require_user()
        if not user:
            return auth_required_response()
        return jsonify(stats_payload(user))

    @app.post("/api/review")
    def review_api():
        data = request.get_json(silent=True) or {}
        user = require_user()
        if not user:
            return auth_required_response()
        question_key = data.get("question_id")
        quality = safe_int(data.get("quality"))
        if not question_key or quality not in {1, 2, 4, 5}:
            return jsonify({"error": "The Oracle needs a valid self-rating."}), 400

        question = Question.query.filter_by(question_id=question_key).first_or_404()
        review = SpacedRepetition.query.filter_by(user_id=user.id, question_id=question.id).first()
        if not review:
            review = SpacedRepetition(user=user, question=question, next_review_date=date.today())
            db.session.add(review)

        result = schedule_review(
            quality,
            interval_days=review.interval_days,
            ease_factor=review.ease_factor,
            repetitions=review.repetitions,
        )
        review.interval_days = result.interval_days
        review.ease_factor = result.ease_factor
        review.repetitions = result.repetitions
        review.next_review_date = result.next_review_date
        db.session.commit()
        return jsonify(
            {
                "next_review_date": review.next_review_date.isoformat(),
                "interval_days": review.interval_days,
                "next_review_label": review_date_label(review.next_review_date),
            }
        )

    @app.get("/api/review-queue")
    def review_queue_api():
        user = require_user()
        if not user:
            return auth_required_response()
        rows = due_review_query(user).all()
        next_due = (
            SpacedRepetition.query.filter_by(user_id=user.id)
            .filter(SpacedRepetition.next_review_date > date.today())
            .order_by(SpacedRepetition.next_review_date.asc())
            .first()
        )
        return jsonify(
            {
                "questions": [row.question.to_dict() for row in rows],
                "count": len(rows),
                "next_due_date": next_due.next_review_date.isoformat() if next_due else None,
            }
        )

    @app.get("/api/filter-options")
    def filter_options():
        blocks = all_question_blocks()
        tiers = scalar_list(select(distinct(Question.tier)).order_by(Question.tier))
        styles = scalar_list(select(distinct(Question.sba_style)).order_by(Question.sba_style))
        return jsonify(
            {
                "blocks": blocks,
                "topics_by_block": topics_grouped_by_block(),
                "tiers": tiers,
                "styles": [style for style in styles if style],
            }
        )

    @app.get("/api/filter-count")
    def filter_count():
        user = current_user()
        query = filtered_questions_query(request.args)
        show = practice_mode(request.args.get("show") or request.args.get("mode"))
        if not user:
            return auth_required_response()
        if user and show == "unanswered":
            attempted_ids = select(Attempt.question_id).where(Attempt.user_id == user.id)
            query = query.filter(~Question.id.in_(attempted_ids))
        elif user and show == "incorrect":
            query = query.filter(Question.id.in_(latest_incorrect_question_ids(user)))
        elif user and show == "due":
            due_ids = select(SpacedRepetition.question_id).where(
                and_(
                    SpacedRepetition.user_id == user.id,
                    SpacedRepetition.next_review_date <= date.today(),
                )
            )
            query = query.filter(Question.id.in_(due_ids))
        return jsonify({"count": query.count()})

    @app.get("/api/exams/count")
    def exam_count_api():
        user = require_user()
        if not user:
            return auth_required_response()
        ensure_exam_schema()
        query = exam_questions_query(user, request.args)
        return jsonify({"count": query.count()})

    @app.get("/api/exams")
    def exam_list_api():
        user = require_user()
        if not user:
            return auth_required_response()
        ensure_exam_schema()
        sessions = (
            ExamSession.query.filter_by(user_id=user.id)
            .order_by(ExamSession.started_at.desc(), ExamSession.id.desc())
            .limit(8)
            .all()
        )
        return jsonify({"exams": [exam_summary_card_payload(session) for session in sessions]})

    @app.post("/api/exams")
    def create_exam_api():
        user = require_user()
        if not user:
            return auth_required_response()
        ensure_exam_schema()
        data = request.get_json(silent=True) or {}
        question_count = safe_exam_question_count(data.get("question_count"))
        minutes = safe_exam_minutes(data.get("minutes"))
        filters = exam_filters_from_mapping(data)
        query = exam_questions_query(user, filters)
        pool = query.all()
        if len(pool) < question_count:
            return jsonify(
                {
                    "error": f"Only {len(pool)} matching {plural_word(len(pool), 'question', 'questions')} are available. Broaden the content settings or reduce the exam length.",
                    "available": len(pool),
                }
            ), 409
        session_row = ExamSession(
            user=user,
            title=exam_title(filters, question_count),
            question_count=question_count,
            minutes=minutes,
            filters_json=json.dumps(filters),
        )
        db.session.add(session_row)
        db.session.flush()
        for position, question in enumerate(random.sample(pool, question_count), start=1):
            db.session.add(ExamQuestion(session=session_row, question=question, position=position))
        db.session.commit()
        return jsonify(exam_payload(session_row, reveal=False)), 201

    @app.get("/api/exams/<int:session_id>")
    def exam_state_api(session_id):
        user = require_user()
        if not user:
            return auth_required_response()
        ensure_exam_schema()
        session_row = exam_for_user_or_404(session_id, user)
        return jsonify(exam_payload(session_row, reveal=session_row.status == "completed"))

    @app.post("/api/exams/<int:session_id>/answer")
    def exam_answer_api(session_id):
        user = require_user()
        if not user:
            return auth_required_response()
        ensure_exam_schema()
        session_row = exam_for_user_or_404(session_id, user)
        if session_row.status != "active":
            return jsonify({"error": "This exam has already been submitted."}), 409
        data = request.get_json(silent=True) or {}
        question_key = data.get("question_id")
        chosen = str(data.get("chosen_answer", "")).upper()[:1]
        if not question_key or chosen not in {"A", "B", "C", "D", "E"}:
            return jsonify({"error": "Choose an answer before moving on."}), 400
        exam_question = exam_question_by_key(session_row, question_key)
        if not exam_question:
            return jsonify({"error": "That question is not part of this exam."}), 404
        answer = ExamAnswer.query.filter_by(exam_session_id=session_row.id, question_id=exam_question.question_id).first()
        if not answer:
            answer = ExamAnswer(session=session_row, question=exam_question.question)
            db.session.add(answer)
        answer.chosen_answer = chosen
        answer.is_correct = chosen == exam_question.question.correct_answer
        answer.time_taken_seconds = safe_int(data.get("time_taken_seconds"))
        answer.answered_at = utc_now()
        db.session.commit()
        return jsonify({"ok": True, "answered": exam_answer_count(session_row)})

    @app.post("/api/exams/<int:session_id>/submit")
    def exam_submit_api(session_id):
        user = require_user()
        if not user:
            return auth_required_response()
        ensure_exam_schema()
        session_row = exam_for_user_or_404(session_id, user)
        if session_row.status != "completed":
            complete_exam_session(session_row, user)
            db.session.commit()
        return jsonify(exam_payload(session_row, reveal=True))

    @app.post("/api/duels")
    def create_duel():
        user = require_user()
        if not user:
            return auth_required_response()
        ensure_duel_schema()
        data = request.get_json(silent=True) or {}
        question_count = safe_duel_question_count(data.get("question_count"))
        seconds_per_question = safe_duel_seconds(data.get("seconds_per_question"))
        filters = duel_filters_from_mapping(data)
        duel = Duel(
            invite_code=unique_duel_code(),
            creator=user,
            visibility=duel_visibility_from_mapping(data),
            question_count=question_count,
            seconds_per_question=seconds_per_question,
            filters_json=json.dumps(filters),
            status="waiting",
        )
        db.session.add(duel)
        db.session.flush()
        db.session.add(DuelParticipant(duel=duel, user=user, role="creator", ready=False))
        db.session.commit()
        return jsonify(duel_state_payload(duel, user, request.host_url.rstrip("/"))), 201

    @app.get("/api/duels/open")
    def open_duels():
        user = require_user()
        if not user:
            return auth_required_response()
        ensure_duel_schema()
        duels = (
            Duel.query.filter(Duel.visibility == "public", Duel.status.in_(["waiting", "ready"]), ~Duel.questions.any())
            .order_by(Duel.created_at.desc(), Duel.id.desc())
            .limit(20)
            .all()
        )
        return jsonify({"duels": [open_duel_payload(duel) for duel in duels]})

    @app.get("/api/duels/season")
    def duel_season():
        user = require_user()
        if not user:
            return auth_required_response()
        ensure_duel_schema()
        return jsonify(duel_season_payload(user))

    @app.get("/api/duels/<invite_code>/state")
    def duel_state(invite_code):
        user = require_user()
        if not user:
            return auth_required_response()
        ensure_duel_schema()
        duel = duel_by_code_or_404(invite_code)
        if not duel_user_is_participant(duel, user):
            return jsonify({"duel": public_duel_payload(duel, request.host_url.rstrip("/")), "viewer_role": "observer"})
        reconcile_duel_state(duel)
        db.session.commit()
        return jsonify(duel_state_payload(duel, user, request.host_url.rstrip("/")))

    @app.post("/api/duels/<invite_code>/join")
    def join_duel(invite_code):
        user = require_user()
        if not user:
            return auth_required_response()
        ensure_duel_schema()
        duel = duel_by_code_or_404(invite_code)
        if duel_participant_for_user(duel, user.id):
            return jsonify(duel_state_payload(duel, user, request.host_url.rstrip("/")))
        if duel.status not in {"waiting", "ready"}:
            return jsonify({"error": "This duel has already begun."}), 409
        if duel.questions:
            return jsonify({"error": "This room has already locked its question set."}), 409
        if len(duel_participant_rows(duel)) >= duel_player_limit(duel):
            return jsonify({"error": "This room is full."}), 409

        if not duel.opponent_id and user.id != duel.creator_id:
            duel.opponent = user
        db.session.add(DuelParticipant(duel=duel, user=user, role="scholar", ready=False))
        db.session.flush()
        if len(duel_participant_rows(duel)) >= 2:
            duel.status = "ready"
        sync_legacy_duel_ready_flags(duel)
        db.session.commit()
        return jsonify(duel_state_payload(duel, user, request.host_url.rstrip("/")))

    @app.post("/api/duels/<invite_code>/cancel")
    def cancel_duel(invite_code):
        user = require_user()
        if not user:
            return auth_required_response()
        ensure_duel_schema()
        duel = duel_by_code_or_404(invite_code)
        if duel.creator_id != user.id:
            return jsonify({"error": "Only the room creator can remove this lobby."}), 403
        if duel.status not in {"waiting", "ready"} or duel.questions:
            return jsonify({"error": "Only an unstarted lobby can be removed."}), 409
        duel.status = "cancelled"
        db.session.commit()
        return jsonify(duel_state_payload(duel, user, request.host_url.rstrip("/")))

    @app.post("/api/duels/<invite_code>/ready")
    def ready_duel(invite_code):
        user = require_user()
        if not user:
            return auth_required_response()
        ensure_duel_schema()
        duel = duel_by_code_or_404(invite_code)
        role = duel_user_role(duel, user)
        if not role:
            return jsonify({"error": "Only duel participants can ready up."}), 403
        if duel.status not in {"waiting", "ready", "active", "reveal"}:
            return jsonify({"error": "This duel is not ready yet."}), 409
        participant = duel_participant_for_user(duel, user.id)
        if participant:
            participant.ready = True
        if len(duel_participant_rows(duel)) >= 2 and duel.status == "waiting":
            duel.status = "ready"
        sync_legacy_duel_ready_flags(duel)
        if duel.status == "ready" and duel_ready_to_start(duel):
            lock_error = lock_duel_questions(duel)
            if lock_error:
                reset_duel_participant_ready(duel)
                db.session.commit()
                return jsonify(lock_error), 409
            start_duel(duel)
        db.session.commit()
        return jsonify(duel_state_payload(duel, user, request.host_url.rstrip("/")))

    @app.post("/api/duels/<invite_code>/answer")
    def answer_duel(invite_code):
        user = require_user()
        if not user:
            return auth_required_response()
        ensure_duel_schema()
        duel = duel_by_code_or_404(invite_code)
        role = duel_user_role(duel, user)
        if not role:
            return jsonify({"error": "Only duel participants can answer."}), 403
        reconcile_duel_state(duel)
        if duel.status != "active":
            db.session.commit()
            return jsonify(duel_state_payload(duel, user, request.host_url.rstrip("/")))
        data = request.get_json(silent=True) or {}
        chosen = str(data.get("chosen_answer", "")).upper()[:1]
        if chosen not in {"A", "B", "C", "D", "E"}:
            return jsonify({"error": "Choose an answer before submitting."}), 400
        duel_question = current_duel_question(duel)
        if not duel_question:
            return jsonify({"error": "This duel has no current question."}), 409
        existing = DuelAnswer.query.filter_by(duel_id=duel.id, question_id=duel_question.question_id, user_id=user.id).first()
        if existing:
            return jsonify(duel_state_payload(duel, user, request.host_url.rstrip("/")))

        elapsed = min(duel.seconds_per_question, max(0, seconds_between(duel.round_started_at, utc_now())))
        practice_payload = record_attempt_and_awards(user, duel_question.question, chosen, elapsed)
        speed_bonus = duel_speed_bonus(duel, elapsed, practice_payload["correct"])
        db.session.add(
            DuelAnswer(
                duel=duel,
                question=duel_question.question,
                user=user,
                chosen_answer=chosen,
                is_correct=practice_payload["correct"],
                time_taken_seconds=elapsed,
                score=(10 if practice_payload["correct"] else 0) + speed_bonus,
            )
        )
        if duel_round_answered(duel):
            begin_duel_reveal(duel)
        db.session.commit()
        return jsonify(duel_state_payload(duel, user, request.host_url.rstrip("/")))

    @app.post("/api/duels/<invite_code>/next")
    def next_duel_round(invite_code):
        user = require_user()
        if not user:
            return auth_required_response()
        ensure_duel_schema()
        duel = duel_by_code_or_404(invite_code)
        role = duel_user_role(duel, user)
        if not role:
            return jsonify({"error": "Only duel participants can advance the room."}), 403
        reconcile_duel_state(duel)
        if duel.status != "reveal":
            db.session.commit()
            return jsonify(duel_state_payload(duel, user, request.host_url.rstrip("/")))
        participant = duel_participant_for_user(duel, user.id)
        if participant:
            participant.ready = True
        if duel_ready_to_advance(duel):
            advance_duel_round(duel)
        sync_legacy_duel_ready_flags(duel)
        db.session.commit()
        return jsonify(duel_state_payload(duel, user, request.host_url.rstrip("/")))

    @app.post("/api/admin/generate-reset-url")
    def admin_generate_reset_url():
        user = require_user()
        if not is_admin_user(user):
            return admin_required_response()
        data = request.get_json(silent=True) or {}
        email = clean_email(data.get("email"))
        if not email:
            return jsonify({"error": "A valid email address is required."}), 400
        target_user = User.query.filter(func.lower(User.email) == email.lower()).first()
        if not target_user:
            return jsonify({"error": f"No user found with email '{email}'."}), 404
        if not target_user.password_hash:
            return jsonify({"error": f"User '{target_user.username}' does not have a native password."}), 400
        token = create_password_reset_token(target_user)
        canonical_host = current_app.config.get("CANONICAL_HOST", "aesculon.lol")
        if not canonical_host.startswith("http"):
            canonical_host = f"https://{canonical_host}"
        reset_url = f"{canonical_host.rstrip('/')}/reset-password?token={token}"
        return jsonify({
            "username": target_user.username,
            "email": target_user.email,
            "reset_url": reset_url
        })

    @app.get("/api/admin-summary")
    def admin_summary_api():
        ensure_admin_schema()
        user = require_user()
        if not is_admin_user(user):
            return admin_required_response()
        return jsonify(admin_summary_payload())

    @app.get("/api/admin/notifications")
    def admin_notifications_api():
        ensure_app_notification_schema()
        user = require_user()
        if not is_admin_user(user):
            return admin_required_response()
        rows = AppNotification.query.order_by(AppNotification.created_at.desc(), AppNotification.id.desc()).limit(12).all()
        return jsonify({"items": [admin_notification_payload(item) for item in rows]})

    @app.post("/api/admin/notifications")
    def create_admin_notification_api():
        ensure_app_notification_schema()
        user = require_user()
        if not is_admin_user(user):
            return admin_required_response()
        data = request.get_json(silent=True) or {}
        title = clean_site_feedback_text(data.get("title"), limit=160)
        message = clean_site_feedback_text(data.get("message"), limit=1800)
        kind = str(data.get("kind") or "poll").strip().lower()
        if kind not in {"announcement", "poll"}:
            kind = "poll"
        yes_label = clean_site_feedback_text(data.get("yes_label"), limit=48) or "Yes"
        no_label = clean_site_feedback_text(data.get("no_label"), limit=48) or "No"
        if not title or not message:
            return jsonify({"error": "Add a title and message before publishing."}), 400
        notification = AppNotification(
            title=title,
            message=message,
            kind=kind,
            yes_label=yes_label,
            no_label=no_label,
            active=True,
            created_by_user_id=user.id,
        )
        db.session.add(notification)
        db.session.commit()
        return jsonify({"ok": True, "notification": admin_notification_payload(notification)})

    @app.post("/api/admin/notifications/<int:notification_id>/delete")
    def delete_admin_notification_api(notification_id):
        ensure_app_notification_schema()
        user = require_user()
        if not is_admin_user(user):
            return admin_required_response()
        notification = db.session.get(AppNotification, notification_id)
        if not notification:
            return jsonify({"error": "Notification not found."}), 404
        db.session.delete(notification)
        db.session.commit()
        return jsonify({"ok": True})

    @app.get("/api/patch-notes")
    def get_patch_notes_api():
        ensure_patch_notes_schema()
        note = PatchNote.query.filter_by(active=True).order_by(PatchNote.created_at.desc(), PatchNote.id.desc()).first()
        if not note:
            return jsonify({"note": None})
        return jsonify({
            "note": {
                "id": note.id,
                "version": note.version,
                "title": note.title,
                "content": note.content
            }
        })

    @app.get("/api/admin/patch-notes")
    def admin_patch_notes_api():
        ensure_patch_notes_schema()
        user = require_user()
        if not is_admin_user(user):
            return admin_required_response()
        rows = PatchNote.query.order_by(PatchNote.created_at.desc(), PatchNote.id.desc()).limit(12).all()
        return jsonify({"items": [{"id": item.id, "version": item.version, "title": item.title, "content": item.content, "active": item.active, "created_at": item.created_at.isoformat()} for item in rows]})

    @app.post("/api/admin/patch-notes")
    def create_admin_patch_notes_api():
        ensure_patch_notes_schema()
        user = require_user()
        if not is_admin_user(user):
            return admin_required_response()
        data = request.get_json(silent=True) or {}
        version = clean_site_feedback_text(data.get("version"), limit=50)
        title = clean_site_feedback_text(data.get("title"), limit=160)
        content = clean_site_feedback_text(data.get("content"), limit=4000)
        if not version or not title or not content:
            return jsonify({"error": "Version, title, and content items are all required."}), 400
        
        note = PatchNote.query.filter_by(version=version).first()
        if note:
            note.title = title
            note.content = content
            note.active = True
        else:
            note = PatchNote(
                version=version,
                title=title,
                content=content,
                active=True
            )
            db.session.add(note)
        
        db.session.commit()
        return jsonify({"ok": True, "patch_note": {"id": note.id, "version": note.version, "title": note.title, "content": note.content, "active": note.active}})

    @app.post("/api/admin/patch-notes/<int:note_id>/delete")
    def delete_admin_patch_note_api(note_id):
        ensure_patch_notes_schema()
        user = require_user()
        if not is_admin_user(user):
            return admin_required_response()
        note = db.session.get(PatchNote, note_id)
        if not note:
            return jsonify({"error": "Patch note not found."}), 404
        db.session.delete(note)
        db.session.commit()
        return jsonify({"ok": True})

    @app.get("/api/admin/question-feedback")
    def admin_question_feedback_api():
        ensure_feedback_schema()
        user = require_user()
        if not is_admin_user(user):
            return admin_required_response()
        return jsonify({"items": question_feedback_items()})

    @app.get("/api/admin/activity")
    def admin_activity_api():
        user = require_user()
        if not is_admin_user(user):
            return admin_required_response()
        return jsonify(admin_activity_payload())

    @app.get("/api/admin/question-bank")
    def admin_question_bank_api():
        ensure_question_bank_schema()
        user = require_user()
        if not is_admin_user(user):
            return admin_required_response()
        return jsonify(admin_question_bank_payload(request.args))

    @app.get("/api/admin/questions/<question_key>")
    def admin_question_detail_api(question_key):
        ensure_question_bank_schema()
        user = require_user()
        if not is_admin_user(user):
            return admin_required_response()
        question_id = clean_question_id(question_key)
        question = Question.query.filter_by(question_id=question_id).first_or_404()
        return jsonify({"question": admin_question_detail_payload(question)})

    @app.put("/api/admin/questions/<question_key>")
    def update_admin_question_api(question_key):
        ensure_question_bank_schema()
        user = require_user()
        if not is_admin_user(user):
            return admin_required_response()
        question_id = clean_question_id(question_key)
        question = Question.query.filter_by(question_id=question_id).first_or_404()
        data = request.get_json(silent=True) or {}
        values, error = admin_question_update_values(data)
        if error:
            return jsonify({"error": error}), 400
        for key, value in values.items():
            setattr(question, key, value)
        question.live_edited_at = utc_now()
        question.live_edited_by_user_id = user.id
        db.session.commit()
        return jsonify({"ok": True, "question": admin_question_detail_payload(question)})

    @app.post("/api/admin/question-feedback/<question_key>/keep")
    def keep_question_feedback_api(question_key):
        ensure_feedback_schema()
        user = require_user()
        if not is_admin_user(user):
            return admin_required_response()
        data = request.get_json(silent=True) or {}
        reply = clean_admin_feedback_text(data.get("reply"))
        source_anchor = clean_admin_feedback_text(data.get("source_anchor"))
        if not reply:
            return jsonify({"error": "Add a short reply before keeping the question."}), 400
        question = Question.query.filter_by(question_id=question_key).first_or_404()
        votes = QuestionQualityVote.query.filter(
            QuestionQualityVote.question_id == question.id,
            QuestionQualityVote.vote.in_(["bad", "not_learnt"]),
            QuestionQualityVote.resolved_action.is_(None),
        ).all()
        resolve_feedback_votes(votes, question.question_id, "kept", user, reply, source_anchor)
        db.session.commit()
        return jsonify({"ok": True, "action": "kept", "question_id": question.question_id})

    @app.post("/api/admin/question-feedback/<question_key>/delete")
    def delete_question_feedback_api(question_key):
        ensure_feedback_schema()
        user = require_user()
        if not is_admin_user(user):
            return admin_required_response()
        data = request.get_json(silent=True) or {}
        reply = clean_admin_feedback_text(data.get("reply")) or "This question was removed from the live bank after review."
        source_anchor = clean_admin_feedback_text(data.get("source_anchor"))
        question = Question.query.filter_by(question_id=question_key).first_or_404()
        votes = QuestionQualityVote.query.filter(
            QuestionQualityVote.question_id == question.id,
            QuestionQualityVote.vote.in_(["bad", "not_learnt"]),
            QuestionQualityVote.resolved_action.is_(None),
        ).all()
        resolve_feedback_votes(votes, question.question_id, "deleted", user, reply, source_anchor)
        db.session.flush()
        retire_question(question.question_id, user)
        return jsonify({"ok": True, "action": "deleted", "question_id": question.question_id})

    @app.post("/api/admin/questions/<question_key>/delete")
    def delete_admin_question_api(question_key):
        ensure_feedback_schema()
        user = require_user()
        if not is_admin_user(user):
            return admin_required_response()
        question_id = clean_question_id(question_key)
        if not question_id:
            return jsonify({"error": "Question ID is required."}), 400
        retire_question(question_id, user)
        return jsonify({"ok": True, "action": "deleted", "question_id": question_id})

    return app


def clean_username(value):
    if not value:
        return ""
    return " ".join(str(value).strip().split())[:40]


def clean_question_id(value):
    if not value:
        return ""
    return "".join(str(value).strip().upper().split())[:80]


def clean_admin_feedback_text(value):
    if not value:
        return ""
    return " ".join(str(value).strip().split())[:1200]


def clean_site_feedback_text(value, limit=1600):
    if not value:
        return ""
    return " ".join(str(value).strip().split())[:limit]


def clean_site_feedback_category(value):
    category = str(value or "").strip().lower().replace(" ", "_")
    return category if category in {"general", "bug", "idea", "content"} else "general"


def clean_question_bank_text(value, limit=4000):
    if value is None:
        return ""
    return str(value).replace("\r\n", "\n").replace("\r", "\n").strip()[:limit]


def clean_question_bank_label(value, limit=180):
    if not value:
        return ""
    return " ".join(str(value).strip().split())[:limit]


def admin_question_update_values(data):
    options = data.get("options") if isinstance(data.get("options"), dict) else {}
    option_values = {
        "option_a": clean_question_bank_text(options.get("A"), 1200),
        "option_b": clean_question_bank_text(options.get("B"), 1200),
        "option_c": clean_question_bank_text(options.get("C"), 1200),
        "option_d": clean_question_bank_text(options.get("D"), 1200),
        "option_e": clean_question_bank_text(options.get("E"), 1200),
    }
    values = {
        "block": clean_question_bank_label(data.get("block")),
        "secondary_blocks": secondary_blocks_json_from_value(data.get("secondary_blocks"), data.get("block")),
        "topic": clean_question_bank_label(data.get("topic")),
        "lecture_no": clean_question_bank_label(data.get("lecture_no")),
        "tier": clean_question_bank_label(data.get("tier"), 80),
        "sba_style": clean_question_bank_label(data.get("sba_style"), 120),
        "stem": clean_question_bank_text(data.get("stem"), 6000),
        "lead_in": clean_question_bank_text(data.get("lead_in"), 3000),
        "correct_answer": clean_question_bank_label(data.get("correct_answer"), 1).upper(),
        "explanation": clean_question_bank_text(data.get("explanation"), 8000),
        "top_distractor": clean_question_bank_text(data.get("top_distractor"), 1200),
        "why_distractor_wrong": clean_question_bank_text(data.get("why_distractor_wrong"), 5000),
        **option_values,
    }

    for key in ("block", "topic", "tier", "stem", "lead_in", "option_a", "option_b", "option_c", "option_d", "correct_answer"):
        if not values[key]:
            return None, f"{key.replace('_', ' ').title()} is required."
    if values["correct_answer"] not in {"A", "B", "C", "D", "E"}:
        return None, "Correct answer must be A, B, C, D, or E."
    correct_option_key = "option_" + values["correct_answer"].lower()
    if not values.get(correct_option_key):
        return None, "Correct answer must point to a non-empty option."
    visible_options = {value for value in option_values.values() if value}
    if values["top_distractor"] and values["top_distractor"] not in visible_options:
        return None, "Common trap must exactly match one of the visible option texts."
    return values, ""


def secondary_blocks_json_from_value(value, primary_block=""):
    if isinstance(value, str):
        raw_items = value.replace(";", ",").split(",")
    elif isinstance(value, list):
        raw_items = value
    else:
        raw_items = []
    primary = clean_question_bank_label(primary_block)
    blocks = []
    for item in raw_items:
        block = clean_question_bank_label(item)
        if block and block != primary and block not in blocks:
            blocks.append(block)
    return json.dumps(blocks)


def resolve_feedback_votes(votes, question_key, action, admin, reply, source_anchor=""):
    now = utc_now()
    for vote in votes:
        vote.resolved_action = action
        vote.admin_reply = reply
        vote.source_anchor = source_anchor
        vote.resolved_by_user_id = admin.id if admin else None
        vote.resolved_at = now
        vote.read_at = None
        db.session.add(
            QuestionFeedbackNotification(
                user_id=vote.user_id,
                question_key=question_key,
                vote=vote.vote,
                action=action,
                admin_reply=reply,
                source_anchor=source_anchor,
            )
        )


def retire_question(question_id, user):
    question_id = clean_question_id(question_id)
    if not question_id:
        return None
    tombstone = DeletedQuestion.query.filter_by(question_id=question_id).first()
    if not tombstone:
        tombstone = DeletedQuestion(question_id=question_id)
        db.session.add(tombstone)
    tombstone.deleted_by_user_id = user.id if user else None
    tombstone.note = "admin_delete"

    question = Question.query.filter_by(question_id=question_id).first()
    if question:
        unresolved_feedback = QuestionQualityVote.query.filter(
            QuestionQualityVote.question_id == question.id,
            QuestionQualityVote.vote.in_(["bad", "not_learnt"]),
            QuestionQualityVote.resolved_action.is_(None),
        ).all()
        resolve_feedback_votes(
            unresolved_feedback,
            question.question_id,
            "deleted",
            user,
            "This question was removed from the live bank after review.",
        )
        db.session.flush()
        DuelAnswer.query.filter_by(question_id=question.id).delete(synchronize_session=False)
        DuelQuestion.query.filter_by(question_id=question.id).delete(synchronize_session=False)
        QuestionQualityVote.query.filter_by(question_id=question.id).delete(synchronize_session=False)
        SpacedRepetition.query.filter_by(question_id=question.id).delete(synchronize_session=False)
        Attempt.query.filter_by(question_id=question.id).delete(synchronize_session=False)
        db.session.delete(question)
    db.session.commit()
    return question


def clean_email(value):
    if not value:
        return ""
    email = str(value).strip().lower()
    if "@" not in email or "." not in email.rsplit("@", 1)[-1]:
        return ""
    return email[:254]


def validate_password(password):
    if len(password) < 8:
        return "Choose a password with at least 8 characters."
    if len(password) > 128:
        return "Choose a shorter password."
    return ""


def truthy_env(value):
    return str(value or "").strip().lower() in {"1", "true", "yes", "on"}


def falsy_env(value):
    return str(value or "").strip().lower() in {"0", "false", "no", "off"}


def load_feature_flags():
    flags = {}
    for key, default in FEATURE_FLAG_DEFAULTS.items():
        env_name = f"ENABLE_{key.upper()}"
        raw = os.environ.get(env_name)
        if raw is None:
            flags[key] = default
        else:
            flags[key] = truthy_env(raw)
    return flags


def feature_enabled(name):
    flags = current_app.config.get("FEATURE_FLAGS", FEATURE_FLAG_DEFAULTS)
    return bool(flags.get(name, False))


def password_reset_serializer():
    return URLSafeTimedSerializer(current_app.config["SECRET_KEY"], salt="aesculon-password-reset")


def create_password_reset_token(user):
    return password_reset_serializer().dumps({"user_id": user.id, "password_hash": user.password_hash or ""})


def verify_password_reset_token(token):
    if not token:
        return None
    try:
        payload = password_reset_serializer().loads(
            token,
            max_age=current_app.config.get("PASSWORD_RESET_MAX_AGE_SECONDS", 3600),
        )
    except (BadSignature, SignatureExpired):
        return None
    user = db.session.get(User, safe_int(payload.get("user_id")))
    token_hash = str(payload.get("password_hash") or "")
    if not user or not user.password_hash or not hmac.compare_digest(token_hash, user.password_hash):
        return None
    return user


def send_password_reset_email(user, reset_url):
    from email.utils import formatdate, make_msgid
    host = current_app.config.get("SMTP_HOST")
    from_email = current_app.config.get("SMTP_FROM_EMAIL")
    if not host or not from_email:
        current_app.logger.warning("Password reset email requested, but SMTP_HOST or SMTP_FROM_EMAIL is not configured.")
        return False
    message = EmailMessage()
    message["Subject"] = "Reset your Aesculon password"
    message["From"] = from_email
    message["To"] = user.email
    message["Date"] = formatdate(localtime=True)
    message["Message-ID"] = make_msgid()
    message.set_content(
        "A password reset was requested for your Aesculon account.\n\n"
        f"Open this link within {current_app.config.get('PASSWORD_RESET_MAX_AGE_SECONDS', 3600) // 60} minutes:\n"
        f"{reset_url}\n\n"
        "If you did not request this, you can ignore this email."
    )
    try:
        if current_app.config.get("SMTP_USE_SSL"):
            smtp = smtplib.SMTP_SSL(current_app.config["SMTP_HOST"], current_app.config["SMTP_PORT"], timeout=10)
        else:
            smtp = smtplib.SMTP(current_app.config["SMTP_HOST"], current_app.config["SMTP_PORT"], timeout=10)
        with smtp:
            if current_app.config.get("SMTP_USE_TLS") and not current_app.config.get("SMTP_USE_SSL"):
                smtp.ehlo()
                smtp.starttls()
                smtp.ehlo()
            username = current_app.config.get("SMTP_USERNAME")
            password = current_app.config.get("SMTP_PASSWORD")
            if username:
                smtp.login(username, password)
            smtp.send_message(message)
    except Exception:
        current_app.logger.exception("Password reset email could not be sent.")
        return False
    return True


def admin_email_set(value):
    return {item.strip().lower() for item in str(value or "").split(",") if item.strip()}


def login_user(user, remember=True):
    session.clear()
    session.permanent = bool(remember)
    session["user_id"] = user.id


def current_user():
    user_id = session.get("user_id")
    if not user_id:
        return None
    return db.session.get(User, user_id)


def require_user():
    return current_user()


def is_admin_user(user):
    if not user or not user.email:
        return False
    admins = current_app_config_admins()
    return user.email.lower() in admins


def current_app_config_admins():
    return current_app.config.get("ADMIN_EMAILS", set())


def auth_required_response():
    return jsonify({"error": "Enter the temple with an account first.", "auth_required": True}), 401


def admin_required_response():
    return jsonify({"error": "Admin access is restricted.", "admin_required": True}), 403


def register_auth_upgrade_command(app):
    @app.cli.command("upgrade-auth-schema")
    def upgrade_auth_schema():
        """Add auth columns to an existing Aesculon database."""
        inspector = inspect(db.engine)
        if "users" not in inspector.get_table_names():
            db.create_all()
            click.echo("Created all tables, including native auth columns.")
            return

        columns = {column["name"] for column in inspector.get_columns("users")}
        statements = []
        if "email" not in columns:
            statements.append("ALTER TABLE users ADD COLUMN email TEXT")
        if "password_hash" not in columns:
            statements.append("ALTER TABLE users ADD COLUMN password_hash TEXT")
        if "auth_provider" not in columns:
            statements.append("ALTER TABLE users ADD COLUMN auth_provider TEXT DEFAULT 'native' NOT NULL")

        for statement in statements:
            db.session.execute(text(statement))
        db.session.execute(text("CREATE UNIQUE INDEX IF NOT EXISTS ix_users_email ON users (email)"))
        db.session.commit()
        click.echo("Auth schema is ready.")


def register_duel_schema_command(app):
    @app.cli.command("upgrade-duel-schema")
    def upgrade_duel_schema():
        """Create the duel tables on an existing database without resetting progress."""
        ensure_duel_schema()
        click.echo("Duel schema is ready.")


def register_feedback_schema_command(app):
    @app.cli.command("upgrade-feedback-schema")
    def upgrade_feedback_schema():
        """Create the feedback and notification tables without resetting progress."""
        ensure_feedback_schema()
        ensure_site_feedback_schema()
        ensure_app_notification_schema()
        click.echo("Feedback and notification schema is ready.")


def register_exam_schema_command(app):
    @app.cli.command("upgrade-exam-schema")
    def upgrade_exam_schema():
        """Create exam-mode tables without resetting progress."""
        ensure_exam_schema()
        click.echo("Exam schema is ready.")


def ensure_admin_schema():
    if current_app.config.get("ADMIN_SCHEMA_READY"):
        return
    inspector = inspect(db.engine)
    tables = set(inspector.get_table_names())
    if "question_quality_votes" not in tables or "deleted_questions" not in tables:
        db.create_all()
    current_app.config["ADMIN_SCHEMA_READY"] = True


def ensure_feedback_schema():
    if current_app.config.get("FEEDBACK_SCHEMA_READY"):
        return
    ensure_admin_schema()
    inspector = inspect(db.engine)
    tables = set(inspector.get_table_names())
    if "question_feedback_notifications" not in tables:
        db.create_all()
        inspector = inspect(db.engine)
        tables = set(inspector.get_table_names())
    if "question_quality_votes" in tables:
        columns = {column["name"] for column in inspector.get_columns("question_quality_votes")}
        statements = []
        if "resolved_action" not in columns:
            statements.append("ALTER TABLE question_quality_votes ADD COLUMN resolved_action TEXT")
        if "admin_reply" not in columns:
            statements.append("ALTER TABLE question_quality_votes ADD COLUMN admin_reply TEXT")
        if "source_anchor" not in columns:
            statements.append("ALTER TABLE question_quality_votes ADD COLUMN source_anchor TEXT")
        if "resolved_by_user_id" not in columns:
            statements.append("ALTER TABLE question_quality_votes ADD COLUMN resolved_by_user_id INTEGER")
        if "resolved_at" not in columns:
            statements.append("ALTER TABLE question_quality_votes ADD COLUMN resolved_at TIMESTAMP")
        if "read_at" not in columns:
            statements.append("ALTER TABLE question_quality_votes ADD COLUMN read_at TIMESTAMP")
        for statement in statements:
            db.session.execute(text(statement))
        if statements:
            db.session.execute(text("CREATE INDEX IF NOT EXISTS ix_question_quality_votes_resolved_action ON question_quality_votes (resolved_action)"))
            db.session.execute(text("CREATE INDEX IF NOT EXISTS ix_question_quality_votes_resolved_by_user_id ON question_quality_votes (resolved_by_user_id)"))
            db.session.execute(text("CREATE INDEX IF NOT EXISTS ix_question_quality_votes_read_at ON question_quality_votes (read_at)"))
            db.session.commit()
    current_app.config["FEEDBACK_SCHEMA_READY"] = True


def ensure_site_feedback_schema():
    if current_app.config.get("SITE_FEEDBACK_SCHEMA_READY"):
        return
    inspector = inspect(db.engine)
    tables = set(inspector.get_table_names())
    if "site_feedback" not in tables:
        db.create_all()
    current_app.config["SITE_FEEDBACK_SCHEMA_READY"] = True


def ensure_app_notification_schema():
    if current_app.config.get("APP_NOTIFICATION_SCHEMA_READY"):
        return
    inspector = inspect(db.engine)
    tables = set(inspector.get_table_names())
    if "app_notifications" not in tables or "app_notification_responses" not in tables:
        db.create_all()
        db.session.commit()
    current_app.config["APP_NOTIFICATION_SCHEMA_READY"] = True


def ensure_patch_notes_schema():
    if current_app.config.get("PATCH_NOTES_SCHEMA_READY"):
        return
    inspector = inspect(db.engine)
    tables = set(inspector.get_table_names())
    if "patch_notes" not in tables:
        db.create_all()
        db.session.commit()
    current_app.config["PATCH_NOTES_SCHEMA_READY"] = True



def ensure_exam_schema():
    if current_app.config.get("EXAM_SCHEMA_READY"):
        return
    inspector = inspect(db.engine)
    tables = set(inspector.get_table_names())
    if "exam_sessions" not in tables or "exam_questions" not in tables or "exam_answers" not in tables:
        db.create_all()
        db.session.commit()
    current_app.config["EXAM_SCHEMA_READY"] = True


def ensure_duel_schema():
    if current_app.config.get("DUEL_SCHEMA_READY"):
        return
    inspector = inspect(db.engine)
    tables = set(inspector.get_table_names())
    if "duels" not in tables or "duel_participants" not in tables or "duel_season_results" not in tables:
        db.create_all()
        inspector = inspect(db.engine)
        tables = set(inspector.get_table_names())
    if "duels" in tables:
        columns = {column["name"] for column in inspector.get_columns("duels")}
        if "visibility" not in columns:
            db.session.execute(text("ALTER TABLE duels ADD COLUMN visibility TEXT DEFAULT 'private' NOT NULL"))
            db.session.execute(text("CREATE INDEX IF NOT EXISTS ix_duels_visibility ON duels (visibility)"))
            db.session.commit()
    current_app.config["DUEL_SCHEMA_READY"] = True


def utc_now():
    return datetime.now(timezone.utc)


def aware_datetime(value):
    if not value:
        return None
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value


def seconds_between(start, end):
    start = aware_datetime(start)
    end = aware_datetime(end)
    if not start or not end:
        return 0
    return max(0, int((end - start).total_seconds()))


def safe_int(value, default=0):
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def plural_word(count, singular, plural_value):
    try:
        return singular if int(count) == 1 else plural_value
    except (TypeError, ValueError):
        return plural_value


def scalar_list(statement):
    return [value for value in db.session.execute(statement).scalars().all() if value]


def roman(number):
    return ROMAN.get(number, str(number))


def level_for_xp(xp):
    xp = max(0, safe_int(xp))
    level = xp_level_for(xp)
    return level_payload(xp, level)


def level_for_user(user):
    metrics = rank_metrics_for_user(user)
    xp = max(0, safe_int(user.total_xp))
    xp_level = xp_level_for(xp)
    gate_level = gate_level_for_metrics(metrics)
    level = min(xp_level, gate_level)
    return level_payload(xp, level, xp_level=xp_level, gate_level=gate_level, metrics=metrics)


def xp_level_for(xp):
    level = 1
    for index, threshold in enumerate(LEVEL_THRESHOLDS, start=1):
        if xp >= threshold:
            level = index
    return min(10, max(1, level))


def level_payload(xp, level, xp_level=None, gate_level=None, metrics=None):
    title, flavour = LEVELS[level - 1]
    next_level = min(10, level + 1)
    current_threshold = LEVEL_THRESHOLDS[level - 1]
    next_threshold = LEVEL_THRESHOLDS[next_level - 1] if level < 10 else current_threshold
    span = max(1, next_threshold - current_threshold)
    xp_into_level = min(span, max(0, xp - current_threshold))
    xp_to_next = max(0, next_threshold - xp) if level < 10 else 0
    next_requirement = LEVEL_REQUIREMENTS[next_level - 1] if level < 10 else LEVEL_REQUIREMENTS[-1]
    next_message = rank_next_message(level, xp_to_next, metrics, next_requirement)
    return {
        "level": level,
        "roman": roman(level),
        "title": title,
        "flavour": flavour,
        "display": f"{title} · {roman(level)}",
        "next_title": LEVELS[next_level - 1][0] if level < 10 else "Oracle",
        "xp_into_level": xp_into_level if level < 10 else span,
        "xp_to_next": xp_to_next,
        "xp_required": span if level < 10 else 0,
        "current_threshold": current_threshold,
        "next_threshold": next_threshold,
        "progress": 100 if level == 10 else round((xp_into_level / span) * 100),
        "xp_level": xp_level or level,
        "gate_level": gate_level or level,
        "requirements": LEVEL_REQUIREMENTS[level - 1],
        "next_requirements": next_requirement,
        "metrics": metrics or {},
        "next_message": next_message,
    }


def rank_next_message(level, xp_to_next, metrics, next_requirement):
    if level >= 10:
        return "At the summit"
    if not metrics:
        return f"{xp_to_next} XP to next level"

    missing = []
    coverage = metrics.get("coverage", 0)
    accuracy = metrics.get("accuracy", 0)
    if coverage < next_requirement["coverage"]:
        missing.append(f"{next_requirement['coverage']}% archive coverage")
    if accuracy < next_requirement["accuracy"]:
        missing.append(f"{next_requirement['accuracy']}% accuracy")
    if xp_to_next:
        missing.insert(0, f"{xp_to_next} XP")
    if not missing:
        return "Ready for the next rank"
    return "Needs " + ", ".join(missing)


def rank_metrics_for_user(user):
    total_attempts = Attempt.query.filter_by(user_id=user.id).count()
    correct = Attempt.query.filter_by(user_id=user.id, is_correct=True).count()
    answered_unique = (
        db.session.query(func.count(distinct(Attempt.question_id)))
        .filter(Attempt.user_id == user.id)
        .scalar()
    )
    total_questions = Question.query.count()
    return {
        "attempts": total_attempts,
        "correct": correct,
        "accuracy": round((correct / total_attempts) * 100, 1) if total_attempts else 0,
        "answered_unique": answered_unique,
        "total_questions": total_questions,
        "coverage": round((answered_unique / total_questions) * 100, 1) if total_questions else 0,
    }


def gate_level_for_metrics(metrics):
    level = 1
    for index, requirement in enumerate(LEVEL_REQUIREMENTS, start=1):
        if metrics["coverage"] >= requirement["coverage"] and metrics["accuracy"] >= requirement["accuracy"]:
            level = index
    return min(10, max(1, level))


def user_payload(user):
    level = level_for_user(user)
    return {
        "id": user.id,
        "username": user.username,
        "total_xp": user.total_xp,
        "streak_days": user.streak_days,
        "streak_shield": user.streak_shield,
        "level": level,
    }


def get_or_create_user(username):
    username = clean_username(username)
    user = User.query.filter(func.lower(User.username) == username.lower()).first()
    if not user:
        user = User(username=username, streak_days=0, streak_shield=False, total_xp=0)
        db.session.add(user)
        db.session.flush()
    return user


def filtered_questions_query(args):
    query = Question.query
    block = clean_question_bank_label(args.get("block"), 180)
    if block:
        query = query.filter(block_filter_condition(block))
    for key, column in (("tier", Question.tier), ("style", Question.sba_style), ("topic", Question.topic)):
        value = args.get(key)
        if value:
            query = query.filter(column == value)
    return query


def block_filter_condition(block):
    return or_(Question.block == block, Question.secondary_blocks.ilike(block_json_match_pattern(block)))


def block_json_match_pattern(block):
    return '%"' + block.replace("\\", "\\\\").replace('"', '\\"') + '"%'


def all_question_blocks():
    blocks = set(scalar_list(select(distinct(Question.block))))
    for value in scalar_list(select(Question.secondary_blocks).where(Question.secondary_blocks.isnot(None))):
        blocks.update(secondary_blocks_list(value))
    return sorted(block for block in blocks if block)


def topics_grouped_by_block():
    grouped = defaultdict(set)
    for question in Question.query.with_entities(Question.block, Question.secondary_blocks, Question.topic).all():
        if not question.topic:
            continue
        for block in question_blocks(question):
            grouped[block].add(question.topic)
    return {key: sorted(value) for key, value in grouped.items()}


def practice_mode(value):
    mode = str(value or "").strip().lower()
    if mode in {"incorrect", "due"}:
        return mode
    return "unanswered"


def record_attempt_and_awards(user, question, chosen, time_taken_seconds):
    old_level = level_for_user(user)
    is_correct = chosen == question.correct_answer
    xp_earned = 10 if is_correct else 2

    attempt = Attempt(
        user=user,
        question=question,
        chosen_answer=chosen,
        is_correct=is_correct,
        time_taken_seconds=safe_int(time_taken_seconds),
    )
    db.session.add(attempt)

    review = upsert_initial_review(user, question, is_correct)
    streak_days, shield_used = update_streak(user, is_correct)
    bonus = streak_bonus(user) + topic_completion_bonus(user, question)
    shield_earned = award_shield_if_due(user)
    user.total_xp += xp_earned + bonus

    new_level = level_for_user(user)
    return {
        "correct": is_correct,
        "correct_answer": question.correct_answer,
        "explanation": question.explanation,
        "top_distractor": question.top_distractor,
        "why_distractor_wrong": question.why_distractor_wrong,
        "xp_earned": xp_earned + bonus,
        "new_total_xp": user.total_xp,
        "levelled_up": new_level["level"] > old_level["level"],
        "new_level": new_level["level"],
        "new_level_title": new_level["title"],
        "new_level_flavour": new_level["flavour"],
        "streak_days": streak_days,
        "shield_earned": shield_earned,
        "shield_used": shield_used,
        "next_review_date": review.next_review_date.isoformat() if review else None,
        "next_review_label": review_date_label(review.next_review_date) if review else None,
        "review_interval_days": review.interval_days if review else None,
    }


def record_duel_timeout_attempt(user, question, seconds):
    db.session.add(
        Attempt(
            user=user,
            question=question,
            chosen_answer=None,
            is_correct=False,
            time_taken_seconds=safe_int(seconds),
        )
    )
    upsert_initial_review(user, question, False)


def update_streak(user, is_correct):
    today = date.today()
    shield_used = False
    if not is_correct:
        return user.streak_days, shield_used

    if user.last_active_date == today:
        return user.streak_days, shield_used

    if user.last_active_date == today - timedelta(days=1):
        user.streak_days += 1
    elif user.last_active_date and user.last_active_date < today - timedelta(days=1):
        if user.streak_shield:
            user.streak_shield = False
            user.streak_days = max(1, user.streak_days)
            shield_used = True
        else:
            user.streak_days = 1
    else:
        user.streak_days = max(1, user.streak_days or 1)

    user.last_active_date = today
    return user.streak_days, shield_used


def streak_bonus(user):
    total_attempts = Attempt.query.filter_by(user_id=user.id).count()
    if not total_attempts or total_attempts % 10 != 0:
        return 0
    recent = Attempt.query.filter_by(user_id=user.id).order_by(Attempt.attempted_at.desc()).limit(10).all()
    if len(recent) == 10 and all(item.is_correct for item in recent):
        return 50
    return 0


def topic_completion_bonus(user, question):
    topic_total = Question.query.filter_by(topic=question.topic, block=question.block).count()
    answered = (
        db.session.query(func.count(distinct(Attempt.question_id)))
        .filter(Attempt.user_id == user.id)
        .join(Question)
        .filter(Question.topic == question.topic, Question.block == question.block)
        .scalar()
    )
    if topic_total and answered == topic_total:
        previous_answers = (
            db.session.query(func.count(Attempt.id))
            .filter(Attempt.user_id == user.id, Attempt.question_id == question.id)
            .scalar()
        )
        if previous_answers == 1:
            return 25
    return 0


def award_shield_if_due(user):
    today_start = datetime.combine(date.today(), datetime.min.time())
    today_attempts = Attempt.query.filter(
        Attempt.user_id == user.id,
        Attempt.attempted_at >= today_start,
    ).count()
    if today_attempts >= 5 and not user.streak_shield:
        user.streak_shield = True
        return True
    return False


def upsert_initial_review(user, question, is_correct):
    review = SpacedRepetition.query.filter_by(user_id=user.id, question_id=question.id).first()
    if not review:
        review = SpacedRepetition(
            user=user,
            question=question,
            next_review_date=date.today(),
            interval_days=1,
            ease_factor=2.5,
            repetitions=0,
        )
        db.session.add(review)
    if is_correct:
        review.next_review_date = date.today() + timedelta(days=3)
        review.interval_days = max(review.interval_days or 1, 3)
    else:
        review.next_review_date = date.today() + timedelta(days=1)
        review.interval_days = 1
        review.repetitions = 0
    return review


def due_review_query(user):
    return (
        SpacedRepetition.query.filter_by(user_id=user.id)
        .filter(SpacedRepetition.next_review_date <= date.today())
        .join(Question)
        .order_by(SpacedRepetition.next_review_date.asc(), Question.question_id.asc())
    )


def next_review_for_user(user):
    return (
        SpacedRepetition.query.filter_by(user_id=user.id)
        .filter(SpacedRepetition.next_review_date > date.today())
        .order_by(SpacedRepetition.next_review_date.asc())
        .first()
    )


def latest_incorrect_question_ids(user):
    latest_attempts = (
        select(func.max(Attempt.id).label("attempt_id"))
        .where(Attempt.user_id == user.id)
        .group_by(Attempt.question_id)
        .subquery()
    )
    return select(Attempt.question_id).where(
        Attempt.id.in_(select(latest_attempts.c.attempt_id)),
        Attempt.is_correct.is_(False),
    )


def select_next_question(questions, user, mode):
    if mode == "unanswered":
        return select_peer_recommended_unanswered_question(questions, user)
    return random.choice(questions)


def select_peer_recommended_unanswered_question(questions, user):
    if not questions:
        return None
    question_ids = [question.id for question in questions]
    good_counts = peer_good_vote_counts(question_ids, user)
    if not good_counts:
        return random.choice(questions)

    highest_good_count = max(good_counts.values())
    if highest_good_count <= 0:
        return random.choice(questions)
    priority_pool = [question for question in questions if good_counts.get(question.id, 0) == highest_good_count]
    return random.choice(priority_pool or questions)


def peer_good_vote_counts(question_ids, user):
    if not question_ids:
        return {}
    query = (
        db.session.query(QuestionQualityVote.question_id, func.count(QuestionQualityVote.id))
        .filter(
            QuestionQualityVote.question_id.in_(question_ids),
            QuestionQualityVote.vote == "good",
        )
    )
    if user:
        query = query.filter(QuestionQualityVote.user_id != user.id)
    rows = query.group_by(QuestionQualityVote.question_id).all()
    return {question_id: count for question_id, count in rows}


def excluded_question_keys(args):
    values = []
    for raw in args.getlist("exclude"):
        values.extend(str(raw).split(","))
    return {item.strip() for item in values if item.strip()}


def safe_exam_question_count(value):
    count = safe_int(value, 20)
    return stepped_int(count, 10, 60, 10)


def safe_exam_minutes(value):
    minutes = safe_int(value, 30)
    return stepped_int(minutes, 10, 90, 10)


def stepped_int(value, minimum, maximum, step):
    value = max(minimum, min(maximum, safe_int(value, minimum)))
    return max(minimum, min(maximum, ((value + (step // 2)) // step) * step))


def exam_filters_from_mapping(data):
    filters = {}
    for key in ("block", "topic", "tier", "style"):
        value = str(data.get(key) or "").strip()
        if value:
            filters[key] = value
    mode = str(data.get("mode") or "unanswered").strip().lower()
    filters["mode"] = mode if mode in {"all", "unanswered", "incorrect", "due"} else "unanswered"
    return filters


def exam_questions_query(user, data):
    filters = exam_filters_from_mapping(data)
    query = filtered_questions_query(filters)
    mode = filters.get("mode") or "unanswered"
    if mode == "unanswered":
        attempted_ids = select(Attempt.question_id).where(Attempt.user_id == user.id)
        query = query.filter(~Question.id.in_(attempted_ids))
    elif mode == "incorrect":
        query = query.filter(Question.id.in_(latest_incorrect_question_ids(user)))
    elif mode == "due":
        due_ids = select(SpacedRepetition.question_id).where(
            and_(
                SpacedRepetition.user_id == user.id,
                SpacedRepetition.next_review_date <= date.today(),
            )
        )
        query = query.filter(Question.id.in_(due_ids))
    return query.order_by(Question.question_id.asc())


def exam_title(filters, question_count):
    label = filters.get("block") or filters.get("topic") or "Mixed archive"
    return f"{label} · {question_count}Q Exam"


def exam_filters_dict(session_row):
    try:
        return json.loads(session_row.filters_json or "{}")
    except json.JSONDecodeError:
        return {}


def exam_for_user_or_404(session_id, user):
    return ExamSession.query.filter_by(id=session_id, user_id=user.id).first_or_404()


def exam_question_by_key(session_row, question_key):
    for item in session_row.questions:
        if item.question and item.question.question_id == question_key:
            return item
    return None


def exam_answer_count(session_row):
    return ExamAnswer.query.filter_by(exam_session_id=session_row.id).count()


def exam_answers_by_question_id(session_row):
    return {answer.question_id: answer for answer in session_row.answers}


def complete_exam_session(session_row, user):
    answers = exam_answers_by_question_id(session_row)
    correct = 0
    answered = 0
    xp_earned = 0
    for item in session_row.questions:
        answer = answers.get(item.question_id)
        chosen = answer.chosen_answer if answer else None
        is_correct = bool(answer and answer.is_correct)
        if answer and chosen:
            answered += 1
            xp_earned += 10 if is_correct else 2
        if is_correct:
            correct += 1
        db.session.add(
            Attempt(
                user=user,
                question=item.question,
                chosen_answer=chosen,
                is_correct=is_correct,
                time_taken_seconds=answer.time_taken_seconds if answer else None,
            )
        )
        upsert_initial_review(user, item.question, is_correct)
        update_streak(user, is_correct)
    user.total_xp += xp_earned
    session_row.status = "completed"
    session_row.submitted_at = utc_now()
    session_row.correct_count = correct
    session_row.answered_count = answered
    session_row.score_percent = accuracy_percent(correct, session_row.question_count)
    return session_row


def exam_payload(session_row, reveal=False):
    answers = exam_answers_by_question_id(session_row)
    return {
        "exam": exam_summary_card_payload(session_row),
        "filters": exam_filters_dict(session_row),
        "questions": [
            exam_question_payload(item, answers.get(item.question_id), reveal)
            for item in session_row.questions
        ],
    }


def exam_summary_card_payload(session_row):
    return {
        "id": session_row.id,
        "title": session_row.title,
        "status": session_row.status,
        "question_count": session_row.question_count,
        "minutes": session_row.minutes,
        "started_at": session_row.started_at.isoformat() if session_row.started_at else None,
        "submitted_at": session_row.submitted_at.isoformat() if session_row.submitted_at else None,
        "correct_count": session_row.correct_count,
        "answered_count": session_row.answered_count,
        "score_percent": round(session_row.score_percent or 0, 1),
    }


def exam_question_payload(item, answer, reveal):
    question = item.question
    payload = question.to_dict(include_answer=reveal)
    payload["position"] = item.position
    payload["chosen_answer"] = answer.chosen_answer if answer else None
    if reveal:
        payload["is_correct"] = bool(answer and answer.is_correct)
    return payload


def safe_duel_question_count(value):
    count = safe_int(value, 5)
    return count if count in {5, 10, 15, 20} else 5


def safe_duel_seconds(value):
    seconds = safe_int(value, 30)
    return seconds if seconds in {15, 30, 45, 60} else 30


def duel_filters_from_mapping(data):
    filters = {}
    for key in ("block", "topic", "tier", "style"):
        value = str(data.get(key) or "").strip()
        if value:
            filters[key] = value
    mode = str(data.get("mode") or "unanswered").strip().lower()
    filters["mode"] = mode if mode in {"all", "unanswered"} else "unanswered"
    return filters


def duel_visibility_from_mapping(data):
    return "public" if str(data.get("visibility") or "").strip().lower() == "public" else "private"


def unique_duel_code():
    while True:
        code = secrets.token_urlsafe(6).replace("-", "").replace("_", "")[:8]
        if not Duel.query.filter_by(invite_code=code).first():
            return code


def duel_by_code_or_404(invite_code):
    return Duel.query.filter(func.lower(Duel.invite_code) == str(invite_code).lower()).first_or_404()


def duel_filters_dict(duel):
    try:
        return json.loads(duel.filters_json or "{}")
    except json.JSONDecodeError:
        return {}


def duel_user_role(duel, user):
    if not user:
        return ""
    participant = duel_participant_for_user(duel, user.id)
    if participant:
        return participant.role
    if duel.creator_id == user.id:
        return "creator"
    if duel.opponent_id == user.id:
        return "opponent"
    return ""


def duel_user_is_participant(duel, user):
    return bool(duel_user_role(duel, user))


def duel_participant_rows(duel):
    rows = list(duel.participants or [])
    if rows:
        return rows
    created = []
    if duel.creator:
        created.append(DuelParticipant(duel=duel, user=duel.creator, role="creator", ready=duel.creator_ready))
    if duel.opponent and duel.opponent_id != duel.creator_id:
        created.append(DuelParticipant(duel=duel, user=duel.opponent, role="opponent", ready=duel.opponent_ready))
    for row in created:
        db.session.add(row)
    if created:
        db.session.flush()
        rows = list(duel.participants or created)
    return rows


def duel_participant_for_user(duel, user_id):
    return next((row for row in duel_participant_rows(duel) if row.user_id == user_id), None)


def duel_participants(duel):
    return [row.user for row in duel_participant_rows(duel) if row.user]


def duel_player_limit(duel):
    return MAX_PUBLIC_DUEL_PLAYERS if (duel.visibility or "private") == "public" else 2


def sync_legacy_duel_ready_flags(duel):
    creator_row = duel_participant_for_user(duel, duel.creator_id)
    opponent_row = duel_participant_for_user(duel, duel.opponent_id) if duel.opponent_id else None
    duel.creator_ready = bool(creator_row and creator_row.ready)
    duel.opponent_ready = bool(opponent_row and opponent_row.ready)


def duel_ready_to_start(duel):
    rows = duel_participant_rows(duel)
    return len(rows) >= 2 and all(row.ready for row in rows)


def duel_ready_to_advance(duel):
    rows = duel_participant_rows(duel)
    return bool(rows) and all(row.ready for row in rows)


def reset_duel_participant_ready(duel):
    for row in duel_participant_rows(duel):
        row.ready = False
    sync_legacy_duel_ready_flags(duel)


def shared_duel_pool_for_participants(duel):
    filters = duel_filters_dict(duel)
    query = filtered_questions_query(filters)
    mode = filters.get("mode") or "unanswered"
    if mode == "unanswered":
        participant_ids = [player.id for player in duel_participants(duel)]
        attempted_ids = select(Attempt.question_id).where(Attempt.user_id.in_(participant_ids))
        query = query.filter(~Question.id.in_(attempted_ids))
    return query.order_by(Question.question_id.asc()).all()


def lock_duel_questions(duel):
    if duel.questions:
        return None
    pool = shared_duel_pool_for_participants(duel)
    filters = duel_filters_dict(duel)
    mode = filters.get("mode") or "unanswered"
    pool_desc = "shared unseen" if mode == "unanswered" else "matching"
    if len(pool) < duel.question_count:
        return {
            "error": f"Only {len(pool)} {pool_desc} {plural_word(len(pool), 'question', 'questions')} are available for this room. Broaden the filters, change the question pool mode, or reduce the count.",
            "available": len(pool),
        }
    locked = random.sample(pool, duel.question_count)
    for position, question in enumerate(locked, start=1):
        db.session.add(DuelQuestion(duel=duel, question=question, position=position))
    db.session.flush()
    return None


def duel_filter_summary(filters):
    labels = []
    for key in ("block", "topic", "tier", "style"):
        value = filters.get(key)
        if value:
            labels.append(str(value))
    return " · ".join(labels) if labels else "All questions"


def open_duel_payload(duel):
    filters = duel_filters_dict(duel)
    player_count = len(duel_participant_rows(duel))
    max_players = duel_player_limit(duel)
    return {
        "invite_code": duel.invite_code,
        "status": duel.status,
        "visibility": duel.visibility or "private",
        "player_count": player_count,
        "max_players": max_players,
        "room_full": player_count >= max_players,
        "question_count": duel.question_count,
        "seconds_per_question": duel.seconds_per_question,
        "filters": filters,
        "filter_summary": duel_filter_summary(filters),
        "creator": duel_player_payload(duel.creator),
        "created_at": duel.created_at.isoformat() if duel.created_at else None,
    }


def public_duel_payload(duel, base_url):
    filters = duel_filters_dict(duel)
    player_count = len(duel_participant_rows(duel))
    max_players = duel_player_limit(duel)
    return {
        "invite_code": duel.invite_code,
        "invite_url": f"{base_url}/duel/{duel.invite_code}",
        "status": duel.status,
        "visibility": duel.visibility or "private",
        "player_count": player_count,
        "max_players": max_players,
        "room_full": player_count >= max_players,
        "question_count": duel.question_count,
        "seconds_per_question": duel.seconds_per_question,
        "filters": filters,
        "filter_summary": duel_filter_summary(filters),
        "creator": duel_player_payload(duel.creator),
        "opponent": duel_player_payload(duel.opponent) if duel.opponent else None,
        "players": duel_players_payload(duel),
    }


def duel_state_payload(duel, viewer, base_url):
    role = duel_user_role(duel, viewer)
    payload = {
        "duel": public_duel_payload(duel, base_url),
        "viewer_role": role,
        "viewer": duel_player_payload(viewer),
        "players": duel_players_payload(duel),
        "round": duel_round_payload(duel, viewer),
        "results": duel_results_payload(duel, viewer) if duel.status == "completed" else None,
    }
    return payload


def duel_player_payload(user):
    if not user:
        return None
    level = level_for_user(user)
    return {
        "id": user.id,
        "username": user.username,
        "total_xp": user.total_xp,
        "level": level,
        "level_display": level["display"],
    }


def duel_players_payload(duel):
    current_question = current_duel_question(duel) if duel.status == "active" else None
    scores = duel_scoreboard(duel, exclude_question_id=current_question.question_id if current_question else None)
    rows = duel_participant_rows(duel)
    return [
        {
            **duel_player_payload(row.user),
            "role": row.role,
            "ready": row.ready,
            "score": scores.get(row.user_id, {}).get("score", 0),
            "correct": scores.get(row.user_id, {}).get("correct", 0),
            "answered": scores.get(row.user_id, {}).get("answered", 0),
        }
        for row in rows
        if row.user
    ]


def duel_round_payload(duel, viewer):
    duel_question = current_duel_question(duel)
    if not duel_question:
        return None
    question = duel_question.question
    reveal = duel.status in {"reveal", "completed"}
    viewer_answer = DuelAnswer.query.filter_by(duel_id=duel.id, question_id=question.id, user_id=viewer.id).first()
    participant_count = len(duel_participants(duel))
    answer_count = DuelAnswer.query.filter_by(duel_id=duel.id, question_id=question.id).count()
    ready_count = sum(1 for row in duel_participant_rows(duel) if row.ready)
    viewer_participant = duel_participant_for_user(duel, viewer.id)
    now = utc_now()
    seconds_elapsed = seconds_between(duel.round_started_at, now) if duel.status == "active" else 0
    seconds_remaining = max(0, duel.seconds_per_question - seconds_elapsed) if duel.status == "active" else 0
    data = {
        "position": duel.round_index + 1,
        "total": duel.question_count,
        "status": duel.status,
        "seconds_per_question": duel.seconds_per_question,
        "seconds_remaining": seconds_remaining,
        "viewer_answer": duel_answer_payload(viewer_answer),
        "answer_count": answer_count,
        "participant_count": participant_count,
        "answers_locked": answer_count >= participant_count,
        "advance_count": ready_count,
        "viewer_ready": bool(viewer_participant and viewer_participant.ready),
        "question": question.to_dict(include_answer=reveal),
    }
    if reveal:
        data["answers"] = {
            str(answer.user_id): duel_answer_payload(answer)
            for answer in DuelAnswer.query.filter_by(duel_id=duel.id, question_id=question.id).all()
        }
    return data


def duel_answer_payload(answer):
    if not answer:
        return None
    return {
        "chosen_answer": answer.chosen_answer,
        "correct": answer.is_correct,
        "time_taken_seconds": answer.time_taken_seconds,
        "score": answer.score,
        "user_id": answer.user_id,
    }


def start_duel(duel):
    duel.status = "active"
    duel.round_index = 0
    duel.round_started_at = utc_now()
    duel.reveal_started_at = None
    reset_duel_participant_ready(duel)


def current_duel_question(duel):
    position = duel.round_index + 1
    return next((item for item in duel.questions if item.position == position), None)


def reconcile_duel_state(duel):
    if duel.status == "active":
        if seconds_between(duel.round_started_at, utc_now()) >= duel.seconds_per_question:
            begin_duel_reveal(duel)


def begin_duel_reveal(duel):
    if duel.status != "active":
        return
    ensure_duel_timeout_answers(duel)
    duel.status = "reveal"
    duel.reveal_started_at = utc_now()
    reset_duel_participant_ready(duel)


def advance_duel_round(duel):
    if duel.round_index + 1 >= duel.question_count:
        duel.status = "completed"
        duel.completed_at = utc_now()
        award_duel_season_results(duel)
        return
    duel.round_index += 1
    duel.status = "active"
    duel.round_started_at = utc_now()
    duel.reveal_started_at = None
    reset_duel_participant_ready(duel)


def ensure_duel_timeout_answers(duel):
    duel_question = current_duel_question(duel)
    if not duel_question:
        return
    existing_user_ids = {
        answer.user_id
        for answer in DuelAnswer.query.filter_by(duel_id=duel.id, question_id=duel_question.question_id).all()
    }
    for player in duel_participants(duel):
        if player.id in existing_user_ids:
            continue
        record_duel_timeout_attempt(player, duel_question.question, duel.seconds_per_question)
        db.session.add(
            DuelAnswer(
                duel=duel,
                question=duel_question.question,
                user=player,
                chosen_answer=None,
                is_correct=False,
                time_taken_seconds=duel.seconds_per_question,
                score=0,
            )
        )


def duel_round_answered(duel):
    duel_question = current_duel_question(duel)
    if not duel_question:
        return False
    needed = len(duel_participants(duel))
    answered = DuelAnswer.query.filter_by(duel_id=duel.id, question_id=duel_question.question_id).count()
    return answered >= needed


def duel_speed_bonus(duel, elapsed, correct):
    if not correct:
        return 0
    remaining_ratio = max(0, duel.seconds_per_question - elapsed) / max(1, duel.seconds_per_question)
    return int(remaining_ratio * 5)


def duel_scoreboard(duel, exclude_question_id=None):
    rows = defaultdict(lambda: {"score": 0, "correct": 0, "answered": 0, "time": 0})
    for answer in DuelAnswer.query.filter_by(duel_id=duel.id).all():
        if exclude_question_id and answer.question_id == exclude_question_id:
            continue
        rows[answer.user_id]["score"] += answer.score
        rows[answer.user_id]["correct"] += 1 if answer.is_correct else 0
        rows[answer.user_id]["answered"] += 1
        rows[answer.user_id]["time"] += answer.time_taken_seconds or 0
    return rows


def current_duel_season():
    today = app_today()
    start = today - timedelta(days=today.weekday())
    end = start + timedelta(days=6)
    return {
        "key": f"arena-{start.isoformat()}",
        "label": f"Arena Season · {short_date_range(start, end)}",
        "starts_on": start.isoformat(),
        "ends_on": end.isoformat(),
    }


def short_date_range(start, end):
    if start.month == end.month:
        return f"{start.day}-{end.day} {end.strftime('%b')}"
    return f"{start.day} {start.strftime('%b')}-{end.day} {end.strftime('%b')}"


def award_duel_season_results(duel):
    if duel.status != "completed" or not duel.completed_at:
        return []
    players = duel_participants(duel)
    if len(players) < 2:
        return []
    if DuelSeasonResult.query.filter_by(duel_id=duel.id).first():
        return duel_season_results_for_duel(duel)

    season = current_duel_season()
    scores = duel_scoreboard(duel)
    top_score = max((scores.get(player.id, {}).get("score", 0) for player in players), default=0)
    winners = [player for player in players if scores.get(player.id, {}).get("score", 0) == top_score]
    is_draw = len(winners) != 1
    results = []
    for player in players:
        values = scores.get(player.id, {})
        correct = values.get("correct", 0)
        total = values.get("answered", 0) or duel.question_count
        outcome = "draw" if is_draw else ("win" if player.id == winners[0].id else "loss")
        arena_points = duel_arena_points(outcome, correct, total)
        result = DuelSeasonResult(
            duel=duel,
            user=player,
            season_key=season["key"],
            season_label=season["label"],
            outcome=outcome,
            arena_points=arena_points,
            duel_score=values.get("score", 0),
            correct=correct,
            total=total,
            accuracy=accuracy_percent(correct, total),
        )
        db.session.add(result)
        results.append(result)
    db.session.flush()
    return results


def duel_arena_points(outcome, correct, total):
    base = {"win": 30, "draw": 15, "loss": 10}.get(outcome, 0)
    perfect_bonus = 5 if total and correct == total else 0
    return base + perfect_bonus


def duel_season_results_for_duel(duel):
    return DuelSeasonResult.query.filter_by(duel_id=duel.id).order_by(DuelSeasonResult.arena_points.desc(), DuelSeasonResult.duel_score.desc()).all()


def duel_season_payload(viewer):
    season = current_duel_season()
    rows = duel_season_leaderboard_rows(season["key"])
    viewer_row = next((row for row in rows if row["user_id"] == viewer.id), None)
    if not viewer_row:
        viewer_row = {
            "rank": None,
            "user_id": viewer.id,
            "username": viewer.username,
            "arena_points": 0,
            "wins": 0,
            "losses": 0,
            "draws": 0,
            "duels": 0,
            "accuracy": 0,
            "streak": 0,
        }
    return {
        "season": season,
        "leaderboard": rows[:10],
        "viewer": viewer_row,
    }


def duel_season_leaderboard_rows(season_key):
    aggregates = (
        db.session.query(
            DuelSeasonResult.user_id,
            User.username,
            func.sum(DuelSeasonResult.arena_points).label("arena_points"),
            func.sum(case((DuelSeasonResult.outcome == "win", 1), else_=0)).label("wins"),
            func.sum(case((DuelSeasonResult.outcome == "loss", 1), else_=0)).label("losses"),
            func.sum(case((DuelSeasonResult.outcome == "draw", 1), else_=0)).label("draws"),
            func.count(DuelSeasonResult.id).label("duels"),
            func.sum(DuelSeasonResult.correct).label("correct"),
            func.sum(DuelSeasonResult.total).label("total"),
        )
        .join(User, User.id == DuelSeasonResult.user_id)
        .filter(DuelSeasonResult.season_key == season_key)
        .group_by(DuelSeasonResult.user_id, User.username)
        .all()
    )
    rows = []
    for row in aggregates:
        rows.append(
            {
                "user_id": row.user_id,
                "username": row.username,
                "arena_points": int(row.arena_points or 0),
                "wins": int(row.wins or 0),
                "losses": int(row.losses or 0),
                "draws": int(row.draws or 0),
                "duels": int(row.duels or 0),
                "accuracy": accuracy_percent(row.correct or 0, row.total or 0),
                "streak": duel_season_streak(row.user_id, season_key),
            }
        )
    rows.sort(key=lambda item: (-item["arena_points"], -item["wins"], -item["accuracy"], item["username"].lower()))
    for rank, row in enumerate(rows, start=1):
        row["rank"] = rank
    return rows


def duel_season_streak(user_id, season_key):
    results = (
        DuelSeasonResult.query.filter_by(user_id=user_id, season_key=season_key)
        .order_by(DuelSeasonResult.created_at.desc(), DuelSeasonResult.id.desc())
        .all()
    )
    streak = 0
    for result in results:
        if result.outcome != "win":
            break
        streak += 1
    return streak


def duel_season_awards_payload(duel):
    results = duel_season_results_for_duel(duel)
    if not results:
        return None
    first = results[0]
    season = {
        "key": first.season_key,
        "label": first.season_label,
    }
    return {
        "season": season,
        "players": [
            {
                "user_id": result.user_id,
                "username": result.user.username if result.user else "Scholar",
                "outcome": result.outcome,
                "arena_points": result.arena_points,
                "duel_score": result.duel_score,
            }
            for result in results
        ],
    }


def duel_results_payload(duel, viewer):
    players = duel_participants(duel)
    answers = DuelAnswer.query.filter_by(duel_id=duel.id).all()
    by_question_user = {(answer.question_id, answer.user_id): answer for answer in answers}
    rows = []
    topic_rows = defaultdict(lambda: defaultdict(lambda: {"correct": 0, "total": 0}))
    for duel_question in duel.questions:
        question = duel_question.question
        item = {
            "position": duel_question.position,
            "question_id": question.question_id,
            "block": question.block,
            "topic": question.topic,
            "correct_answer": question.correct_answer,
            "correct_option": question.to_dict()["options"].get(question.correct_answer),
            "players": {},
        }
        for player in players:
            answer = by_question_user.get((question.id, player.id))
            item["players"][str(player.id)] = duel_answer_payload(answer)
            topic_rows[player.id][question.topic]["total"] += 1
            if answer and answer.is_correct:
                topic_rows[player.id][question.topic]["correct"] += 1
        rows.append(item)

    scores = duel_scoreboard(duel)
    summary = []
    for player in players:
        total = scores.get(player.id, {}).get("answered", 0)
        correct = scores.get(player.id, {}).get("correct", 0)
        total_time = scores.get(player.id, {}).get("time", 0)
        weak_topic = weakest_duel_topic(topic_rows[player.id])
        summary.append(
            {
                **duel_player_payload(player),
                "role": duel_user_role(duel, player),
                "score": scores.get(player.id, {}).get("score", 0),
                "correct": correct,
                "total": duel.question_count,
                "accuracy": round((correct / total) * 100, 1) if total else 0,
                "avg_time": round(total_time / total, 1) if total else 0,
                "weakest_topic": weak_topic,
            }
        )
    return {
        "players": summary,
        "rows": rows,
        "insights": duel_head_to_head_insights(duel, viewer, players, by_question_user),
        "season_awards": duel_season_awards_payload(duel),
    }


def weakest_duel_topic(rows):
    if not rows:
        return None
    ranked = sorted(
        (
            {
                "label": topic,
                "correct": values["correct"],
                "total": values["total"],
                "accuracy": round((values["correct"] / values["total"]) * 100, 1) if values["total"] else 0,
            }
            for topic, values in rows.items()
        ),
        key=lambda item: (item["accuracy"], -item["total"], item["label"]),
    )
    return ranked[0] if ranked else None


def duel_head_to_head_insights(duel, viewer, players, by_question_user):
    others = [player for player in players if player.id != viewer.id]
    if not others:
        return {"shared_misses": 0, "viewer_only": 0, "opponent_only": 0}
    shared_misses = 0
    viewer_only = 0
    opponent_only = 0
    for duel_question in duel.questions:
        viewer_answer = by_question_user.get((duel_question.question_id, viewer.id))
        viewer_correct = bool(viewer_answer and viewer_answer.is_correct)
        others_correct = [
            bool(by_question_user.get((duel_question.question_id, player.id)) and by_question_user[(duel_question.question_id, player.id)].is_correct)
            for player in others
        ]
        if not viewer_correct and not any(others_correct):
            shared_misses += 1
        elif viewer_correct and not any(others_correct):
            viewer_only += 1
        elif any(others_correct) and not viewer_correct:
            opponent_only += 1
    return {"shared_misses": shared_misses, "viewer_only": viewer_only, "opponent_only": opponent_only}


def review_date_label(value):
    if not value:
        return "No review scheduled"
    today = date.today()
    if value <= today:
        return "Due now"
    if value == today + timedelta(days=1):
        return "Tomorrow"
    delta = (value - today).days
    return f"In {delta} days"


def leaderboard_rows(limit=None):
    users = User.query.order_by(desc(User.total_xp), desc(User.streak_days), User.username.asc()).all()
    rows = []
    for rank, user in enumerate(users[:limit] if limit else users, start=1):
        attempts = Attempt.query.filter_by(user_id=user.id).count()
        correct = Attempt.query.filter_by(user_id=user.id, is_correct=True).count()
        accuracy = round((correct / attempts) * 100, 1) if attempts else 0
        level = level_for_user(user)
        rows.append(
            {
                "rank": rank,
                "username": user.username,
                "level_title": level["title"],
                "level_display": level["display"],
                "xp": user.total_xp,
                "streak": user.streak_days,
                "accuracy": accuracy,
                "questions_answered": attempts,
            }
        )
    return rows


def cohort_pulse_payload():
    today = app_today()
    today_start, tomorrow_start = app_day_window(today)
    week_start, _ = app_day_window(today - timedelta(days=6))

    today_attempts = attempts_between(today_start, tomorrow_start)
    week_attempts = attempts_between(week_start, tomorrow_start)
    active_today = active_users_between(today_start, tomorrow_start)
    active_week = active_users_between(week_start, tomorrow_start)
    today_correct = correct_attempts_between(today_start, tomorrow_start)
    week_correct = correct_attempts_between(week_start, tomorrow_start)
    hardest = hardest_topic_between(today_start, tomorrow_start) or hardest_topic_between(week_start, tomorrow_start)
    practiced = most_practiced_block_between(today_start, tomorrow_start) or most_practiced_block_between(week_start, tomorrow_start)

    if today_attempts:
        status = "active"
        copy = f"{active_today} {plural_word(active_today, 'scholar', 'scholars')} entered today."
    elif week_attempts:
        status = "quiet"
        copy = f"The archive is quiet today, but {week_attempts} questions moved this week."
    else:
        status = "empty"
        copy = "The archive is quiet. Be the first to start the pulse."

    return {
        "status": status,
        "copy": copy,
        "active_today": active_today,
        "active_week": active_week,
        "answered_today": today_attempts,
        "answered_week": week_attempts,
        "accuracy_today": accuracy_percent(today_correct, today_attempts),
        "accuracy_week": accuracy_percent(week_correct, week_attempts),
        "hardest_topic": hardest,
        "most_practiced_block": practiced,
    }


def app_timezone():
    name = current_app.config.get("APP_TIMEZONE", "Australia/Sydney")
    try:
        return ZoneInfo(name)
    except Exception:
        return timezone.utc


def app_today():
    return datetime.now(app_timezone()).date()


def app_day_window(value):
    zone = app_timezone()
    start = datetime.combine(value, datetime.min.time(), tzinfo=zone)
    return start.astimezone(timezone.utc), (start + timedelta(days=1)).astimezone(timezone.utc)


def attempts_between(start, end):
    return Attempt.query.filter(Attempt.attempted_at >= start, Attempt.attempted_at < end).count()


def correct_attempts_between(start, end):
    return Attempt.query.filter(Attempt.attempted_at >= start, Attempt.attempted_at < end, Attempt.is_correct.is_(True)).count()


def active_users_between(start, end):
    return (
        db.session.query(func.count(distinct(Attempt.user_id)))
        .filter(Attempt.attempted_at >= start, Attempt.attempted_at < end)
        .scalar()
        or 0
    )


def hardest_topic_between(start, end):
    rows = (
        db.session.query(
            Question.topic.label("topic"),
            Question.block.label("block"),
            func.count(Attempt.id).label("attempted"),
            func.sum(case((Attempt.is_correct.is_(True), 1), else_=0)).label("correct"),
        )
        .select_from(Attempt)
        .join(Question)
        .filter(Attempt.attempted_at >= start, Attempt.attempted_at < end)
        .group_by(Question.topic, Question.block)
        .all()
    )
    candidates = []
    for topic, block, attempted, correct in rows:
        if not topic or not attempted:
            continue
        correct = correct or 0
        accuracy = accuracy_percent(correct, attempted)
        candidates.append({"label": topic, "block": block, "attempted": attempted, "accuracy": accuracy})
    if not candidates:
        return None
    return sorted(candidates, key=lambda item: (item["accuracy"], -item["attempted"], item["label"]))[0]


def most_practiced_block_between(start, end):
    row = (
        db.session.query(Question.block.label("block"), func.count(Attempt.id).label("attempted"))
        .select_from(Attempt)
        .join(Question)
        .filter(Attempt.attempted_at >= start, Attempt.attempted_at < end)
        .group_by(Question.block)
        .order_by(func.count(Attempt.id).desc(), Question.block.asc())
        .first()
    )
    if not row:
        return None
    return {"label": row.block, "attempted": row.attempted}


def accuracy_percent(correct, attempted):
    return round((correct / attempted) * 100, 1) if attempted else 0


def plural_word(count, singular, plural):
    return singular if count == 1 else plural


def stats_payload(user):
    attempts = Attempt.query.filter_by(user_id=user.id).all()
    total = len(attempts)
    correct = sum(1 for item in attempts if item.is_correct)
    avg_time = round(sum(item.time_taken_seconds or 0 for item in attempts) / total, 1) if total else 0

    by_block = breakdown(user, Question.block)
    by_tier = breakdown(user, Question.tier)
    by_topic = breakdown(user, Question.topic)
    weakest = sorted([item for item in by_topic if item["attempted"]], key=lambda x: x["accuracy"])[:5]
    due_count = due_review_query(user).count()
    next_due = next_review_for_user(user)
    answered_unique = (
        db.session.query(func.count(distinct(Attempt.question_id)))
        .filter(Attempt.user_id == user.id)
        .scalar()
    )
    total_questions = Question.query.count()
    recent_attempts = (
        Attempt.query.filter_by(user_id=user.id)
        .join(Question)
        .order_by(Attempt.attempted_at.desc())
        .limit(8)
        .all()
    )
    recent_mistakes = (
        Attempt.query.filter_by(user_id=user.id, is_correct=False)
        .join(Question)
        .order_by(Attempt.attempted_at.desc())
        .limit(5)
        .all()
    )
    due_soon = (
        SpacedRepetition.query.filter_by(user_id=user.id)
        .filter(SpacedRepetition.next_review_date >= date.today())
        .join(Question)
        .order_by(SpacedRepetition.next_review_date.asc(), Question.question_id.asc())
        .limit(5)
        .all()
    )
    xp_history = []
    for offset in range(13, -1, -1):
        day = date.today() - timedelta(days=offset)
        start = datetime.combine(day, datetime.min.time(), tzinfo=timezone.utc)
        end = start + timedelta(days=1)
        day_attempts = Attempt.query.filter(
            Attempt.user_id == user.id,
            Attempt.attempted_at >= start,
            Attempt.attempted_at < end,
        ).all()
        earned = sum(10 if item.is_correct else 2 for item in day_attempts)
        xp_history.append({"date": day.isoformat(), "xp": earned})

    return {
        "summary": {
            "attempted": total,
            "correct": correct,
            "accuracy": round((correct / total) * 100, 1) if total else 0,
            "avg_time": avg_time,
            "total_xp": user.total_xp,
            "level": level_for_user(user),
            "due_count": due_count,
            "next_due_date": next_due.next_review_date.isoformat() if next_due else None,
            "next_due_label": "Due now" if due_count else (review_date_label(next_due.next_review_date) if next_due else "No review scheduled"),
            "answered_unique": answered_unique,
            "total_questions": total_questions,
            "completion": round((answered_unique / total_questions) * 100, 1) if total_questions else 0,
        },
        "by_block": by_block,
        "by_tier": by_tier,
        "by_topic": sorted(by_topic, key=lambda x: x["accuracy"] if x["attempted"] else 101),
        "xp_history": xp_history,
        "weakest_topics": weakest,
        "recent_activity": [recent_attempt_payload(item) for item in recent_attempts],
        "recent_mistakes": [recent_attempt_payload(item) for item in recent_mistakes],
        "due_soon": [review_item_payload(item) for item in due_soon],
    }


def recent_attempt_payload(attempt):
    return {
        "question_id": attempt.question.question_id,
        "block": attempt.question.block,
        "topic": attempt.question.topic,
        "correct": attempt.is_correct,
        "attempted_at": attempt.attempted_at.isoformat() if attempt.attempted_at else None,
    }


def review_item_payload(review):
    return {
        "question_id": review.question.question_id,
        "block": review.question.block,
        "topic": review.question.topic,
        "next_review_date": review.next_review_date.isoformat(),
        "next_review_label": review_date_label(review.next_review_date),
    }


def normalize_question_quality_vote(value):
    vote = str(value or "").strip().lower().replace("-", "_").replace(" ", "_")
    return vote if vote in {"good", "bad", "not_learnt"} else ""


def question_quality_label(value):
    return {
        "good": "Good",
        "bad": "Bad",
        "not_learnt": "Not learnt",
    }.get(value, value)


def question_quality_counts(question_id):
    rows = (
        db.session.query(QuestionQualityVote.vote, func.count(QuestionQualityVote.id))
        .filter(QuestionQualityVote.question_id == question_id)
        .group_by(QuestionQualityVote.vote)
        .all()
    )
    counts = {"good": 0, "bad": 0, "not_learnt": 0}
    for vote, count in rows:
        if vote in counts:
            counts[vote] = count
    return counts


def compact_question_preview(question):
    if not question:
        return {"stem": "", "lead_in": ""}
    return {
        "stem": " ".join((question.stem or "").split())[:260],
        "lead_in": " ".join((question.lead_in or "").split())[:180],
    }


def feedback_notification_payload(item):
    action_label = "kept" if item.action == "kept" else "deleted"
    question = Question.query.filter_by(question_id=item.question_key).first()
    preview = compact_question_preview(question)
    return {
        "id": item.id,
        "question_id": item.question_key,
        "stem": preview["stem"],
        "lead_in": preview["lead_in"],
        "vote": item.vote,
        "label": question_quality_label(item.vote),
        "action": item.action,
        "action_label": action_label,
        "admin_reply": item.admin_reply,
        "source_anchor": item.source_anchor,
        "created_at": item.created_at.isoformat() if item.created_at else None,
    }


def question_feedback_items():
    rows = (
        db.session.query(
            Question,
            func.sum(case((QuestionQualityVote.vote == "bad", 1), else_=0)).label("bad_count"),
            func.sum(case((QuestionQualityVote.vote == "not_learnt", 1), else_=0)).label("not_learnt_count"),
            func.max(QuestionQualityVote.updated_at).label("latest_vote_at"),
        )
        .join(QuestionQualityVote, QuestionQualityVote.question_id == Question.id)
        .filter(
            QuestionQualityVote.vote.in_(["bad", "not_learnt"]),
            QuestionQualityVote.resolved_action.is_(None),
        )
        .group_by(Question.id)
        .order_by(desc("latest_vote_at"))
        .all()
    )
    items = []
    for question, bad_count, not_learnt_count, latest_vote_at in rows:
        voters = (
            db.session.query(User.username, QuestionQualityVote.vote, QuestionQualityVote.updated_at)
            .join(User, User.id == QuestionQualityVote.user_id)
            .filter(
                QuestionQualityVote.question_id == question.id,
                QuestionQualityVote.vote.in_(["bad", "not_learnt"]),
                QuestionQualityVote.resolved_action.is_(None),
            )
            .order_by(QuestionQualityVote.updated_at.desc())
            .limit(8)
            .all()
        )
        items.append(
            {
                "question_id": question.question_id,
                "block": question.block,
                "topic": question.topic,
                "tier": question.tier,
                "stem": question.stem,
                "lead_in": question.lead_in,
                "correct_answer": question.correct_answer,
                "correct_option": getattr(question, f"option_{question.correct_answer.lower()}", ""),
                "bad_count": int(bad_count or 0),
                "not_learnt_count": int(not_learnt_count or 0),
                "latest_vote_at": latest_vote_at.isoformat() if latest_vote_at else None,
                "voters": [
                    {
                        "username": username,
                        "vote": vote,
                        "label": question_quality_label(vote),
                        "updated_at": updated_at.isoformat() if updated_at else None,
                    }
                    for username, vote, updated_at in voters
                ],
            }
        )
    return items


def admin_summary_payload():
    ensure_site_feedback_schema()
    ensure_app_notification_schema()
    users = User.query.count()
    questions = Question.query.count()
    deleted_questions = DeletedQuestion.query.count()
    attempts = Attempt.query.count()
    review_records = SpacedRepetition.query.count()
    due_reviews = SpacedRepetition.query.filter(SpacedRepetition.next_review_date <= date.today()).count()
    blocks = all_question_blocks()
    topics = db.session.query(func.count(distinct(Question.topic))).scalar() or 0
    latest_attempt = Attempt.query.order_by(Attempt.attempted_at.desc()).first()
    return {
        "users": users,
        "questions": questions,
        "deleted_questions": deleted_questions,
        "attempts": attempts,
        "review_records": review_records,
        "due_reviews": due_reviews,
        "blocks": blocks,
        "topics": topics,
        "latest_attempt_at": latest_attempt.attempted_at.isoformat() if latest_attempt else None,
        "quality": question_quality_payload(),
        "site_feedback_count": SiteFeedback.query.count(),
        "recent_site_feedback": recent_site_feedback_items(),
        "notification_count": AppNotification.query.count(),
        "feature_flags": current_app.config.get("FEATURE_FLAGS", FEATURE_FLAG_DEFAULTS),
    }


def recent_site_feedback_items(limit=8):
    rows = SiteFeedback.query.order_by(SiteFeedback.created_at.desc(), SiteFeedback.id.desc()).limit(limit).all()
    return [
        {
            "id": item.id,
            "username": item.user.username if item.user else "Guest",
            "category": item.category,
            "message": item.message,
            "page_path": item.page_path,
            "created_at": item.created_at.isoformat() if item.created_at else None,
        }
        for item in rows
    ]


def normalize_notification_response(value):
    response = str(value or "").strip().lower()
    return response if response in {"yes", "no", "dismissed"} else ""


def app_notification_payload(item):
    return {
        "id": item.id,
        "title": item.title,
        "message": item.message,
        "kind": item.kind,
        "yes_label": item.yes_label or "Yes",
        "no_label": item.no_label or "No",
        "created_at": item.created_at.isoformat() if item.created_at else None,
    }


def admin_notification_payload(item):
    counts = notification_response_counts(item.id)
    payload = app_notification_payload(item)
    payload.update(
        {
            "active": bool(item.active),
            "created_by": item.created_by.username if item.created_by else "Admin",
            "responses": counts,
            "voters": notification_response_voters(item.id),
            "total_responses": sum(counts.values()),
        }
    )
    return payload


def notification_response_counts(notification_id):
    rows = (
        db.session.query(AppNotificationResponse.response, func.count(AppNotificationResponse.id))
        .filter(AppNotificationResponse.notification_id == notification_id)
        .group_by(AppNotificationResponse.response)
        .all()
    )
    counts = {"yes": 0, "no": 0, "dismissed": 0}
    for response, count in rows:
        if response in counts:
            counts[response] = int(count or 0)
    return counts


def notification_response_voters(notification_id):
    rows = (
        AppNotificationResponse.query.filter_by(notification_id=notification_id)
        .order_by(AppNotificationResponse.created_at.asc(), AppNotificationResponse.id.asc())
        .all()
    )
    voters = {"yes": [], "no": [], "dismissed": []}
    for row in rows:
        if row.response not in voters:
            continue
        voters[row.response].append(
            {
                "username": row.user.username if row.user else "Unknown",
                "created_at": row.created_at.isoformat() if row.created_at else None,
            }
        )
    return voters


def admin_question_bank_payload(args):
    query_text = clean_question_bank_label(args.get("q"), 120)
    block = clean_question_bank_label(args.get("block"), 180)
    topic = clean_question_bank_label(args.get("topic"), 180)
    status = clean_question_bank_label(args.get("status"), 40)
    limit = min(80, max(10, safe_int(args.get("limit"), 30)))

    query = Question.query
    if query_text:
        pattern = f"%{query_text}%"
        query = query.filter(
            or_(
                Question.question_id.ilike(pattern),
                Question.block.ilike(pattern),
                Question.secondary_blocks.ilike(pattern),
                Question.topic.ilike(pattern),
                Question.lecture_no.ilike(pattern),
                Question.stem.ilike(pattern),
                Question.lead_in.ilike(pattern),
                Question.option_a.ilike(pattern),
                Question.option_b.ilike(pattern),
                Question.option_c.ilike(pattern),
                Question.option_d.ilike(pattern),
                Question.option_e.ilike(pattern),
                Question.explanation.ilike(pattern),
                Question.top_distractor.ilike(pattern),
            )
        )
    if block:
        query = query.filter(block_filter_condition(block))
    if topic:
        query = query.filter(Question.topic == topic)
    if status == "live_edited":
        query = query.filter(Question.live_edited_at.isnot(None))
    elif status == "pristine":
        query = query.filter(Question.live_edited_at.is_(None))

    total_matches = query.count()
    rows = query.order_by(Question.question_id.asc()).limit(limit).all()
    blocks = all_question_blocks()
    topics = scalar_list(select(distinct(Question.topic)).order_by(Question.topic))
    live_edited_count = Question.query.filter(Question.live_edited_at.isnot(None)).count()
    return {
        "items": [admin_question_row_payload(question) for question in rows],
        "total_matches": total_matches,
        "limit": limit,
        "blocks": blocks,
        "topics": topics,
        "live_edited_count": live_edited_count,
        "question_count": Question.query.count(),
    }


def admin_question_row_payload(question):
    counts = question_quality_counts(question.id)
    return {
        "question_id": question.question_id,
        "block": question.block,
        "secondary_blocks": secondary_blocks_list(question.secondary_blocks),
        "blocks": question_blocks(question),
        "topic": question.topic,
        "tier": question.tier,
        "sba_style": question.sba_style or "",
        "lecture_no": question.lecture_no or "",
        "stem": " ".join((question.stem or "").split())[:220],
        "lead_in": " ".join((question.lead_in or "").split())[:160],
        "correct_answer": question.correct_answer,
        "correct_option": question_option_text(question, question.correct_answer),
        "live_edited": bool(question.live_edited_at),
        "live_edited_at": question.live_edited_at.isoformat() if question.live_edited_at else None,
        "live_edited_by": question.live_edited_by.username if question.live_edited_by else "",
        "votes": counts,
        "attempts": Attempt.query.filter_by(question_id=question.id).count(),
    }


def admin_question_detail_payload(question):
    payload = question.to_dict(include_answer=True)
    payload.update(
        {
            "live_edited": bool(question.live_edited_at),
            "live_edited_at": question.live_edited_at.isoformat() if question.live_edited_at else None,
            "live_edited_by": question.live_edited_by.username if question.live_edited_by else "",
            "votes": question_quality_counts(question.id),
            "attempts": Attempt.query.filter_by(question_id=question.id).count(),
        }
    )
    return payload


def question_option_text(question, key):
    return {
        "A": question.option_a,
        "B": question.option_b,
        "C": question.option_c,
        "D": question.option_d,
        "E": question.option_e,
    }.get(str(key or "").upper()) or ""


def admin_activity_payload():
    today_start = datetime.combine(date.today(), datetime.min.time())
    users = User.query.order_by(User.username.asc()).all()
    rows = [admin_activity_user_payload(user, today_start) for user in users]
    rows.sort(key=lambda item: (item["latest_attempt_at"] or "", item["xp"], item["attempts"]), reverse=True)
    recent_attempts = Attempt.query.order_by(Attempt.attempted_at.desc(), Attempt.id.desc()).limit(30).all()
    return {
        "users": rows,
        "recent_attempts": [admin_recent_attempt_payload(item) for item in recent_attempts],
    }


def admin_activity_user_payload(user, today_start):
    attempts = Attempt.query.filter_by(user_id=user.id).count()
    correct = Attempt.query.filter_by(user_id=user.id, is_correct=True).count()
    unique_answered = (
        db.session.query(func.count(distinct(Attempt.question_id)))
        .filter(Attempt.user_id == user.id)
        .scalar()
        or 0
    )
    today_attempts = Attempt.query.filter(
        Attempt.user_id == user.id,
        Attempt.attempted_at >= today_start,
    ).count()
    latest_attempt = (
        Attempt.query.filter_by(user_id=user.id)
        .order_by(Attempt.attempted_at.desc(), Attempt.id.desc())
        .first()
    )
    feedback_reports = QuestionQualityVote.query.filter(
        QuestionQualityVote.user_id == user.id,
        QuestionQualityVote.vote.in_(["bad", "not_learnt"]),
    ).count()
    due_reviews = SpacedRepetition.query.filter(
        SpacedRepetition.user_id == user.id,
        SpacedRepetition.next_review_date <= date.today(),
    ).count()
    duel_answers = DuelAnswer.query.filter_by(user_id=user.id).count()
    level = level_for_user(user)
    return {
        "id": user.id,
        "username": user.username,
        "email": user.email or "",
        "level": level["display"],
        "xp": user.total_xp,
        "streak": user.streak_days,
        "attempts": attempts,
        "unique_answered": unique_answered,
        "today_attempts": today_attempts,
        "correct": correct,
        "accuracy": round((correct / attempts) * 100, 1) if attempts else 0,
        "due_reviews": due_reviews,
        "feedback_reports": feedback_reports,
        "duel_answers": duel_answers,
        "last_active_date": user.last_active_date.isoformat() if user.last_active_date else None,
        "latest_attempt_at": latest_attempt.attempted_at.isoformat() if latest_attempt and latest_attempt.attempted_at else None,
    }


def admin_recent_attempt_payload(attempt):
    return {
        "username": attempt.user.username if attempt.user else "Unknown",
        "question_id": attempt.question.question_id if attempt.question else "",
        "block": attempt.question.block if attempt.question else "",
        "topic": attempt.question.topic if attempt.question else "",
        "chosen_answer": attempt.chosen_answer or "",
        "is_correct": bool(attempt.is_correct),
        "attempted_at": attempt.attempted_at.isoformat() if attempt.attempted_at else None,
    }


def question_quality_payload():
    duplicate_stems = (
        db.session.query(func.lower(func.trim(Question.stem)).label("stem"), func.count(Question.id).label("count"))
        .group_by(func.lower(func.trim(Question.stem)))
        .having(func.count(Question.id) > 1)
        .count()
    )
    missing_explanations = Question.query.filter(or_(Question.explanation.is_(None), func.length(func.trim(Question.explanation)) == 0)).count()
    short_explanations = Question.query.filter(func.length(func.trim(func.coalesce(Question.explanation, ""))) < 80).count()
    missing_traps = Question.query.filter(
        or_(
            Question.top_distractor.is_(None),
            func.length(func.trim(Question.top_distractor)) == 0,
            Question.why_distractor_wrong.is_(None),
            func.length(func.trim(Question.why_distractor_wrong)) == 0,
        )
    ).count()
    missing_options = Question.query.filter(
        or_(
            Question.option_a.is_(None),
            func.length(func.trim(Question.option_a)) == 0,
            Question.option_b.is_(None),
            func.length(func.trim(Question.option_b)) == 0,
            Question.option_c.is_(None),
            func.length(func.trim(Question.option_c)) == 0,
            Question.option_d.is_(None),
            func.length(func.trim(Question.option_d)) == 0,
        )
    ).count()
    return {
        "duplicate_stems": duplicate_stems,
        "missing_explanations": missing_explanations,
        "short_explanations": short_explanations,
        "missing_traps": missing_traps,
        "missing_options": missing_options,
    }


def breakdown(user, group_column):
    rows = (
        db.session.query(
            group_column.label("label"),
            func.count(Attempt.id).label("attempted"),
            func.sum(case((Attempt.is_correct.is_(True), 1), else_=0)).label("correct"),
        )
        .select_from(Attempt)
        .join(Question)
        .filter(Attempt.user_id == user.id)
        .group_by(group_column)
        .all()
    )
    output = []
    for label, attempted, correct in rows:
        correct = correct or 0
        output.append(
            {
                "label": label,
                "attempted": attempted,
                "correct": correct,
                "accuracy": round((correct / attempted) * 100, 1) if attempted else 0,
            }
        )
    return output


app = create_app()
