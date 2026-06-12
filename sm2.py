from dataclasses import dataclass
from datetime import date, timedelta


@dataclass
class ReviewResult:
    next_review_date: date
    interval_days: int
    ease_factor: float
    repetitions: int


def schedule_review(quality, interval_days=1, ease_factor=2.5, repetitions=0, today=None):
    """Small SM-2 variant tuned for four self-ratings: 5, 4, 2, 1."""
    today = today or date.today()
    quality = max(0, min(5, int(quality)))

    if quality < 3:
        repetitions = 0
        interval_days = 1
    else:
        repetitions += 1
        if repetitions == 1:
            interval_days = 1
        elif repetitions == 2:
            interval_days = 3
        else:
            interval_days = max(1, round(interval_days * ease_factor))

    ease_factor = ease_factor + (0.1 - (5 - quality) * (0.08 + (5 - quality) * 0.02))
    ease_factor = max(1.3, round(ease_factor, 2))

    return ReviewResult(
        next_review_date=today + timedelta(days=interval_days),
        interval_days=interval_days,
        ease_factor=ease_factor,
        repetitions=repetitions,
    )
