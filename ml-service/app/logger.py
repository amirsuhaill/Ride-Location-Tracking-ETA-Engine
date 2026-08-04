"""Structured JSON logging for ml-service — the Python-side counterpart to core/src/logger.ts.

Uses the same minimal field vocabulary (`time`, `level`, `msg`) as core's pino-backed logs, plus
matching camelCase field names for request logging (`method`, `path`, `statusCode`, `latencyMs`,
see the middleware in app/main.py) — deliberately so a shared log aggregator sees a consistent
shape regardless of which service a line came from. `level` is a lowercase string here (Python's
own logging convention: "info"/"warning"/"error") rather than pino's numeric levels (30/40/50) —
forcing Python's ecosystem to speak Node's numeric log-level protocol would fight standard
practice for no real benefit. `time` is epoch milliseconds either way, so lines from both
services still correlate and sort correctly in a combined log stream.
"""

import json
import logging

from app.config import settings


class JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        payload = {
            "level": record.levelname.lower(),
            "time": int(record.created * 1000),
            "msg": record.getMessage(),
            "logger": record.name,
        }
        if record.exc_info:
            payload["err"] = self.formatException(record.exc_info)
        fields = getattr(record, "fields", None)
        if isinstance(fields, dict):
            payload.update(fields)
        return json.dumps(payload)


def _configure() -> logging.Logger:
    handler = logging.StreamHandler()
    handler.setFormatter(JsonFormatter())

    root = logging.getLogger()
    root.handlers = [handler]
    root.setLevel(settings.log_level.upper())

    # uvicorn's own startup/error loggers otherwise attach their own plain-text handler — route
    # them through the same JSON formatter so a container's log stream is one consistent shape,
    # not two. The access logger specifically is disabled in the Dockerfile CMD
    # (`--no-access-log`) in favor of this project's own structured request-logging middleware
    # (app/main.py), the same "one line per request" convention core's Fastify setup uses.
    for name in ("uvicorn", "uvicorn.error"):
        uv_logger = logging.getLogger(name)
        uv_logger.handlers = [handler]
        uv_logger.propagate = False

    return logging.getLogger("ml-service")


logger = _configure()
