from datetime import date

from flask_sqlalchemy import SQLAlchemy
from werkzeug.security import check_password_hash, generate_password_hash


db = SQLAlchemy()


class User(db.Model):
    __tablename__ = "users"

    id = db.Column(db.Integer, primary_key=True)
    username = db.Column(db.Text, unique=True, nullable=False)
    email = db.Column(db.Text, unique=True, index=True)
    password_hash = db.Column(db.Text)
    auth_provider = db.Column(db.Text, default="native", nullable=False)
    created_at = db.Column(db.DateTime(timezone=True), server_default=db.func.now())
    last_active_date = db.Column(db.Date)
    streak_days = db.Column(db.Integer, default=0, nullable=False)
    streak_shield = db.Column(db.Boolean, default=False, nullable=False)
    total_xp = db.Column(db.Integer, default=0, nullable=False)

    attempts = db.relationship("Attempt", back_populates="user", cascade="all, delete-orphan")
    reviews = db.relationship("SpacedRepetition", back_populates="user", cascade="all, delete-orphan")
    exam_sessions = db.relationship("ExamSession", back_populates="user", cascade="all, delete-orphan")
    created_duels = db.relationship("Duel", foreign_keys="Duel.creator_id", back_populates="creator")
    joined_duels = db.relationship("Duel", foreign_keys="Duel.opponent_id", back_populates="opponent")

    def set_password(self, password):
        self.password_hash = generate_password_hash(password)

    def check_password(self, password):
        return bool(self.password_hash and check_password_hash(self.password_hash, password))


class Question(db.Model):
    __tablename__ = "questions"

    id = db.Column(db.Integer, primary_key=True)
    question_id = db.Column(db.Text, unique=True, nullable=False, index=True)
    block = db.Column(db.Text, nullable=False, index=True)
    secondary_blocks = db.Column(db.Text)
    topic = db.Column(db.Text, nullable=False, index=True)
    lecture_no = db.Column(db.Text)
    tier = db.Column(db.Text, nullable=False, index=True)
    sba_style = db.Column(db.Text, index=True)
    stem = db.Column(db.Text, nullable=False)
    lead_in = db.Column(db.Text, nullable=False)
    option_a = db.Column(db.Text)
    option_b = db.Column(db.Text)
    option_c = db.Column(db.Text)
    option_d = db.Column(db.Text)
    option_e = db.Column(db.Text)
    correct_answer = db.Column(db.String(1), nullable=False)
    explanation = db.Column(db.Text)
    top_distractor = db.Column(db.Text)
    why_distractor_wrong = db.Column(db.Text)
    live_edited_at = db.Column(db.DateTime(timezone=True), index=True)
    live_edited_by_user_id = db.Column(db.Integer, db.ForeignKey("users.id"), index=True)

    attempts = db.relationship("Attempt", back_populates="question", cascade="all, delete-orphan")
    reviews = db.relationship("SpacedRepetition", back_populates="question", cascade="all, delete-orphan")
    quality_votes = db.relationship("QuestionQualityVote", back_populates="question", cascade="all, delete-orphan")
    live_edited_by = db.relationship("User", foreign_keys=[live_edited_by_user_id])

    def to_dict(self, include_answer=True):
        data = {
            "id": self.id,
            "question_id": self.question_id,
            "block": self.block,
            "secondary_blocks": secondary_blocks_list(self.secondary_blocks),
            "blocks": question_blocks(self),
            "topic": self.topic,
            "lecture_no": self.lecture_no,
            "tier": self.tier,
            "sba_style": self.sba_style,
            "stem": self.stem,
            "lead_in": self.lead_in,
            "options": {
                "A": self.option_a,
                "B": self.option_b,
                "C": self.option_c,
                "D": self.option_d,
                "E": self.option_e,
            },
        }
        if include_answer:
            data.update(
                {
                    "correct_answer": self.correct_answer,
                    "explanation": self.explanation,
                    "top_distractor": self.top_distractor,
                    "why_distractor_wrong": self.why_distractor_wrong,
                }
            )
        return data


def secondary_blocks_list(value):
    if not value:
        return []
    import json

    try:
        parsed = json.loads(value)
    except (TypeError, ValueError):
        return []
    if not isinstance(parsed, list):
        return []
    return [str(item) for item in parsed if str(item).strip()]


def question_blocks(question):
    blocks = [question.block] if question.block else []
    for block in secondary_blocks_list(question.secondary_blocks):
        if block and block not in blocks:
            blocks.append(block)
    return blocks


class Attempt(db.Model):
    __tablename__ = "attempts"

    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.Integer, db.ForeignKey("users.id"), nullable=False, index=True)
    question_id = db.Column(db.Integer, db.ForeignKey("questions.id"), nullable=False, index=True)
    chosen_answer = db.Column(db.String(1))
    is_correct = db.Column(db.Boolean, nullable=False)
    time_taken_seconds = db.Column(db.Integer)
    attempted_at = db.Column(db.DateTime(timezone=True), server_default=db.func.now(), index=True)

    user = db.relationship("User", back_populates="attempts")
    question = db.relationship("Question", back_populates="attempts")


class SpacedRepetition(db.Model):
    __tablename__ = "spaced_repetition"
    __table_args__ = (db.UniqueConstraint("user_id", "question_id", name="uq_user_question_review"),)

    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.Integer, db.ForeignKey("users.id"), nullable=False, index=True)
    question_id = db.Column(db.Integer, db.ForeignKey("questions.id"), nullable=False, index=True)
    next_review_date = db.Column(db.Date, nullable=False, default=date.today, index=True)
    interval_days = db.Column(db.Integer, default=1, nullable=False)
    ease_factor = db.Column(db.Float, default=2.5, nullable=False)
    repetitions = db.Column(db.Integer, default=0, nullable=False)

    user = db.relationship("User", back_populates="reviews")
    question = db.relationship("Question", back_populates="reviews")


class QuestionQualityVote(db.Model):
    __tablename__ = "question_quality_votes"
    __table_args__ = (db.UniqueConstraint("user_id", "question_id", name="uq_user_question_quality_vote"),)

    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.Integer, db.ForeignKey("users.id"), nullable=False, index=True)
    question_id = db.Column(db.Integer, db.ForeignKey("questions.id"), nullable=False, index=True)
    vote = db.Column(db.Text, nullable=False, index=True)
    resolved_action = db.Column(db.Text, index=True)
    admin_reply = db.Column(db.Text)
    source_anchor = db.Column(db.Text)
    resolved_by_user_id = db.Column(db.Integer, db.ForeignKey("users.id"), index=True)
    resolved_at = db.Column(db.DateTime(timezone=True))
    read_at = db.Column(db.DateTime(timezone=True))
    created_at = db.Column(db.DateTime(timezone=True), server_default=db.func.now(), index=True)
    updated_at = db.Column(db.DateTime(timezone=True), server_default=db.func.now(), onupdate=db.func.now())

    user = db.relationship("User", foreign_keys=[user_id])
    question = db.relationship("Question", back_populates="quality_votes")
    resolved_by = db.relationship("User", foreign_keys=[resolved_by_user_id])


class QuestionFeedbackNotification(db.Model):
    __tablename__ = "question_feedback_notifications"

    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.Integer, db.ForeignKey("users.id"), nullable=False, index=True)
    question_key = db.Column(db.Text, nullable=False, index=True)
    vote = db.Column(db.Text, nullable=False)
    action = db.Column(db.Text, nullable=False, index=True)
    admin_reply = db.Column(db.Text)
    source_anchor = db.Column(db.Text)
    created_at = db.Column(db.DateTime(timezone=True), server_default=db.func.now(), index=True)
    read_at = db.Column(db.DateTime(timezone=True), index=True)

    user = db.relationship("User")


class SiteFeedback(db.Model):
    __tablename__ = "site_feedback"

    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.Integer, db.ForeignKey("users.id"), index=True)
    category = db.Column(db.Text, nullable=False, default="general", index=True)
    message = db.Column(db.Text, nullable=False)
    page_path = db.Column(db.Text)
    user_agent = db.Column(db.Text)
    created_at = db.Column(db.DateTime(timezone=True), server_default=db.func.now(), index=True)

    user = db.relationship("User")


class AppNotification(db.Model):
    __tablename__ = "app_notifications"

    id = db.Column(db.Integer, primary_key=True)
    title = db.Column(db.Text, nullable=False)
    message = db.Column(db.Text, nullable=False)
    kind = db.Column(db.Text, default="announcement", nullable=False, index=True)
    yes_label = db.Column(db.Text, default="Yes")
    no_label = db.Column(db.Text, default="No")
    active = db.Column(db.Boolean, default=True, nullable=False, index=True)
    created_by_user_id = db.Column(db.Integer, db.ForeignKey("users.id"), index=True)
    created_at = db.Column(db.DateTime(timezone=True), server_default=db.func.now(), index=True)

    created_by = db.relationship("User")
    responses = db.relationship("AppNotificationResponse", back_populates="notification", cascade="all, delete-orphan")


class AppNotificationResponse(db.Model):
    __tablename__ = "app_notification_responses"
    __table_args__ = (db.UniqueConstraint("user_id", "notification_id", name="uq_user_app_notification_response"),)

    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.Integer, db.ForeignKey("users.id"), nullable=False, index=True)
    notification_id = db.Column(db.Integer, db.ForeignKey("app_notifications.id"), nullable=False, index=True)
    response = db.Column(db.Text, nullable=False, index=True)
    created_at = db.Column(db.DateTime(timezone=True), server_default=db.func.now(), index=True)

    user = db.relationship("User")
    notification = db.relationship("AppNotification", back_populates="responses")


class DeletedQuestion(db.Model):
    __tablename__ = "deleted_questions"

    id = db.Column(db.Integer, primary_key=True)
    question_id = db.Column(db.Text, unique=True, nullable=False, index=True)
    deleted_by_user_id = db.Column(db.Integer, db.ForeignKey("users.id"), index=True)
    deleted_at = db.Column(db.DateTime(timezone=True), server_default=db.func.now(), index=True)
    note = db.Column(db.Text)

    deleted_by = db.relationship("User")


class ExamSession(db.Model):
    __tablename__ = "exam_sessions"

    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.Integer, db.ForeignKey("users.id"), nullable=False, index=True)
    title = db.Column(db.Text, nullable=False, default="Exam Sprint")
    status = db.Column(db.Text, nullable=False, default="active", index=True)
    question_count = db.Column(db.Integer, nullable=False)
    minutes = db.Column(db.Integer, nullable=False)
    filters_json = db.Column(db.Text, default="{}", nullable=False)
    started_at = db.Column(db.DateTime(timezone=True), server_default=db.func.now(), index=True)
    submitted_at = db.Column(db.DateTime(timezone=True), index=True)
    correct_count = db.Column(db.Integer, default=0, nullable=False)
    answered_count = db.Column(db.Integer, default=0, nullable=False)
    score_percent = db.Column(db.Float, default=0, nullable=False)

    user = db.relationship("User", back_populates="exam_sessions")
    questions = db.relationship("ExamQuestion", back_populates="session", cascade="all, delete-orphan", order_by="ExamQuestion.position")
    answers = db.relationship("ExamAnswer", back_populates="session", cascade="all, delete-orphan")


class ExamQuestion(db.Model):
    __tablename__ = "exam_questions"
    __table_args__ = (db.UniqueConstraint("exam_session_id", "position", name="uq_exam_question_position"),)

    id = db.Column(db.Integer, primary_key=True)
    exam_session_id = db.Column(db.Integer, db.ForeignKey("exam_sessions.id"), nullable=False, index=True)
    question_id = db.Column(db.Integer, db.ForeignKey("questions.id"), nullable=False, index=True)
    position = db.Column(db.Integer, nullable=False)

    session = db.relationship("ExamSession", back_populates="questions")
    question = db.relationship("Question")


class ExamAnswer(db.Model):
    __tablename__ = "exam_answers"
    __table_args__ = (db.UniqueConstraint("exam_session_id", "question_id", name="uq_exam_answer_question"),)

    id = db.Column(db.Integer, primary_key=True)
    exam_session_id = db.Column(db.Integer, db.ForeignKey("exam_sessions.id"), nullable=False, index=True)
    question_id = db.Column(db.Integer, db.ForeignKey("questions.id"), nullable=False, index=True)
    chosen_answer = db.Column(db.String(1))
    is_correct = db.Column(db.Boolean, default=False, nullable=False)
    time_taken_seconds = db.Column(db.Integer, default=0, nullable=False)
    answered_at = db.Column(db.DateTime(timezone=True), server_default=db.func.now(), index=True)

    session = db.relationship("ExamSession", back_populates="answers")
    question = db.relationship("Question")


class Duel(db.Model):
    __tablename__ = "duels"

    id = db.Column(db.Integer, primary_key=True)
    invite_code = db.Column(db.Text, unique=True, nullable=False, index=True)
    creator_id = db.Column(db.Integer, db.ForeignKey("users.id"), nullable=False, index=True)
    opponent_id = db.Column(db.Integer, db.ForeignKey("users.id"), index=True)
    status = db.Column(db.Text, default="waiting", nullable=False, index=True)
    visibility = db.Column(db.Text, default="private", nullable=False, index=True)
    question_count = db.Column(db.Integer, default=5, nullable=False)
    seconds_per_question = db.Column(db.Integer, default=30, nullable=False)
    round_index = db.Column(db.Integer, default=0, nullable=False)
    round_started_at = db.Column(db.DateTime(timezone=True))
    reveal_started_at = db.Column(db.DateTime(timezone=True))
    filters_json = db.Column(db.Text, default="{}", nullable=False)
    creator_ready = db.Column(db.Boolean, default=False, nullable=False)
    opponent_ready = db.Column(db.Boolean, default=False, nullable=False)
    created_at = db.Column(db.DateTime(timezone=True), server_default=db.func.now(), index=True)
    completed_at = db.Column(db.DateTime(timezone=True))

    creator = db.relationship("User", foreign_keys=[creator_id], back_populates="created_duels")
    opponent = db.relationship("User", foreign_keys=[opponent_id], back_populates="joined_duels")
    participants = db.relationship("DuelParticipant", back_populates="duel", cascade="all, delete-orphan", order_by="DuelParticipant.joined_at")
    questions = db.relationship("DuelQuestion", back_populates="duel", cascade="all, delete-orphan", order_by="DuelQuestion.position")
    answers = db.relationship("DuelAnswer", back_populates="duel", cascade="all, delete-orphan")


class DuelParticipant(db.Model):
    __tablename__ = "duel_participants"
    __table_args__ = (db.UniqueConstraint("duel_id", "user_id", name="uq_duel_participant_user"),)

    id = db.Column(db.Integer, primary_key=True)
    duel_id = db.Column(db.Integer, db.ForeignKey("duels.id"), nullable=False, index=True)
    user_id = db.Column(db.Integer, db.ForeignKey("users.id"), nullable=False, index=True)
    role = db.Column(db.Text, default="scholar", nullable=False)
    ready = db.Column(db.Boolean, default=False, nullable=False)
    joined_at = db.Column(db.DateTime(timezone=True), server_default=db.func.now(), index=True)

    duel = db.relationship("Duel", back_populates="participants")
    user = db.relationship("User")


class DuelQuestion(db.Model):
    __tablename__ = "duel_questions"
    __table_args__ = (db.UniqueConstraint("duel_id", "position", name="uq_duel_question_position"),)

    id = db.Column(db.Integer, primary_key=True)
    duel_id = db.Column(db.Integer, db.ForeignKey("duels.id"), nullable=False, index=True)
    question_id = db.Column(db.Integer, db.ForeignKey("questions.id"), nullable=False, index=True)
    position = db.Column(db.Integer, nullable=False)

    duel = db.relationship("Duel", back_populates="questions")
    question = db.relationship("Question")


class DuelAnswer(db.Model):
    __tablename__ = "duel_answers"
    __table_args__ = (db.UniqueConstraint("duel_id", "question_id", "user_id", name="uq_duel_answer_user_question"),)

    id = db.Column(db.Integer, primary_key=True)
    duel_id = db.Column(db.Integer, db.ForeignKey("duels.id"), nullable=False, index=True)
    question_id = db.Column(db.Integer, db.ForeignKey("questions.id"), nullable=False, index=True)
    user_id = db.Column(db.Integer, db.ForeignKey("users.id"), nullable=False, index=True)
    chosen_answer = db.Column(db.String(1))
    is_correct = db.Column(db.Boolean, nullable=False)
    time_taken_seconds = db.Column(db.Integer, default=0, nullable=False)
    score = db.Column(db.Integer, default=0, nullable=False)
    answered_at = db.Column(db.DateTime(timezone=True), server_default=db.func.now(), index=True)

    duel = db.relationship("Duel", back_populates="answers")
    question = db.relationship("Question")
    user = db.relationship("User")


class DuelSeasonResult(db.Model):
    __tablename__ = "duel_season_results"
    __table_args__ = (db.UniqueConstraint("duel_id", "user_id", name="uq_duel_season_result_user"),)

    id = db.Column(db.Integer, primary_key=True)
    duel_id = db.Column(db.Integer, db.ForeignKey("duels.id"), nullable=False, index=True)
    user_id = db.Column(db.Integer, db.ForeignKey("users.id"), nullable=False, index=True)
    season_key = db.Column(db.Text, nullable=False, index=True)
    season_label = db.Column(db.Text, nullable=False)
    outcome = db.Column(db.Text, nullable=False)
    arena_points = db.Column(db.Integer, default=0, nullable=False)
    duel_score = db.Column(db.Integer, default=0, nullable=False)
    correct = db.Column(db.Integer, default=0, nullable=False)
    total = db.Column(db.Integer, default=0, nullable=False)
    accuracy = db.Column(db.Float, default=0, nullable=False)
    created_at = db.Column(db.DateTime(timezone=True), server_default=db.func.now(), index=True)

    duel = db.relationship("Duel")
    user = db.relationship("User")


class PatchNote(db.Model):
    __tablename__ = "patch_notes"

    id = db.Column(db.Integer, primary_key=True)
    version = db.Column(db.Text, nullable=False, unique=True)
    title = db.Column(db.Text, nullable=False)
    content = db.Column(db.Text, nullable=False)
    active = db.Column(db.Boolean, default=True, nullable=False, index=True)
    created_at = db.Column(db.DateTime(timezone=True), server_default=db.func.now(), index=True)

