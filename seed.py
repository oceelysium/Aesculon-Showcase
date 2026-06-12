import json
from pathlib import Path

import click
from flask import current_app
from sqlalchemy import inspect, text

from models import DeletedQuestion, Question, db


def register_seed_command(app):
    @app.cli.command("upgrade-question-bank-schema")
    def upgrade_question_bank_schema():
        """Add question-bank sync protection columns without resetting progress."""
        db.create_all()
        ensure_question_bank_schema()
        click.echo("Question bank schema is ready.")

    @app.cli.command("seed-db")
    def seed_db():
        """Drop, recreate, and populate the database from questions.json."""
        records = load_question_records()

        db.drop_all()
        db.create_all()

        for item in records:
            db.session.add(Question(**question_values(item)))

        db.session.commit()
        click.echo(f"Seeded {Question.query.count()} questions into the Aesculon archive.")

    @app.cli.command("sync-question-bank")
    @click.option("--force", is_flag=True, help="Overwrite questions that were edited live in the database.")
    def sync_question_bank(force):
        """Update or add questions from questions.json without deleting user data."""
        db.create_all()
        ensure_question_bank_schema()
        records = load_question_records()
        existing = {question.question_id: question for question in Question.query.all()}
        deleted_ids = {item.question_id for item in DeletedQuestion.query.all()}
        created = 0
        skipped_deleted = 0
        skipped_live_edited = 0
        forced_live_updates = 0
        updated = 0
        renamed = 0

        for item in records:
            if item["question_id"] in deleted_ids:
                skipped_deleted += 1
                continue
            values = question_values(item)
            question = existing.get(item["question_id"])
            if not question:
                for legacy_id in legacy_question_ids(item["question_id"]):
                    question = existing.get(legacy_id)
                    if question:
                        renamed += 1
                        existing[item["question_id"]] = question
                        break
            if not question:
                db.session.add(Question(**values))
                created += 1
                continue
            if question.live_edited_at and not force:
                skipped_live_edited += 1
                continue
            for key, value in values.items():
                setattr(question, key, value)
            if question.live_edited_at and force:
                question.live_edited_at = None
                question.live_edited_by_user_id = None
                forced_live_updates += 1
            updated += 1

        db.session.commit()
        click.echo(
            f"Synced {updated} existing questions, renamed {renamed}, added {created} new questions, "
            f"skipped {skipped_deleted} deleted questions, and skipped {skipped_live_edited} live-edited questions."
        )
        if forced_live_updates:
            click.echo(f"Force-updated {forced_live_updates} live-edited questions and cleared their live-edit protection.")


def load_question_records():
    source = Path(current_app.root_path) / "questions.json"
    if not source.exists():
        raise click.ClickException("questions.json was not found in the project root.")
    with source.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def question_values(item):
    options = item.get("options", {})
    return {
        "question_id": item["question_id"],
        "block": item["block"],
        "secondary_blocks": secondary_blocks_json(item),
        "topic": item["topic"],
        "lecture_no": item.get("lecture_no"),
        "tier": item["tier"],
        "sba_style": item.get("sba_style"),
        "stem": item["stem"],
        "lead_in": item["lead_in"],
        "option_a": options.get("A"),
        "option_b": options.get("B"),
        "option_c": options.get("C"),
        "option_d": options.get("D"),
        "option_e": options.get("E"),
        "correct_answer": item["correct_answer"],
        "explanation": item.get("explanation"),
        "top_distractor": item.get("top_distractor"),
        "why_distractor_wrong": item.get("why_distractor_wrong"),
    }


def ensure_question_bank_schema():
    if current_app.config.get("QUESTION_BANK_SCHEMA_READY"):
        return
    inspector = inspect(db.engine)
    tables = set(inspector.get_table_names())
    if "questions" not in tables:
        db.create_all()
        current_app.config["QUESTION_BANK_SCHEMA_READY"] = True
        return

    columns = {column["name"] for column in inspector.get_columns("questions")}
    statements = []
    if "live_edited_at" not in columns:
        statements.append("ALTER TABLE questions ADD COLUMN live_edited_at TIMESTAMP")
    if "live_edited_by_user_id" not in columns:
        statements.append("ALTER TABLE questions ADD COLUMN live_edited_by_user_id INTEGER")
    if "secondary_blocks" not in columns:
        statements.append("ALTER TABLE questions ADD COLUMN secondary_blocks TEXT")

    for statement in statements:
        db.session.execute(text(statement))
    if statements:
        db.session.execute(text("CREATE INDEX IF NOT EXISTS ix_questions_live_edited_at ON questions (live_edited_at)"))
        db.session.execute(text("CREATE INDEX IF NOT EXISTS ix_questions_live_edited_by_user_id ON questions (live_edited_by_user_id)"))
        db.session.commit()
    current_app.config["QUESTION_BANK_SCHEMA_READY"] = True


def secondary_blocks_json(item):
    raw = item.get("secondary_blocks") or item.get("blocks_secondary") or item.get("additional_blocks") or []
    if isinstance(raw, str):
        raw = [part.strip() for part in raw.replace(";", ",").split(",")]
    if not isinstance(raw, list):
        raw = []
    blocks = []
    primary = str(item.get("block") or "").strip()
    for value in raw:
        block = " ".join(str(value or "").strip().split())
        if block and block != primary and block not in blocks:
            blocks.append(block)
    return json.dumps(blocks)


def legacy_question_ids(question_id):
    """Map the former Set 2 IDs onto the unified Q001-Q200 sequence."""
    if not question_id.startswith("Q"):
        return []
    try:
        number = int(question_id[1:])
    except ValueError:
        return []
    if 101 <= number <= 200:
        return [f"S2Q{number - 100:03d}"]
    return []
