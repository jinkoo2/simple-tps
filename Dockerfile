FROM python:3.12-slim

LABEL description="Simple TPS core library, CLI, and web viewer"

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app

COPY pyproject.toml README.md ./
COPY src ./src

RUN python -m pip install --upgrade pip setuptools wheel \
    && python -m pip install ".[web]"

WORKDIR /workspace

ENTRYPOINT ["simple-tps"]
CMD ["web", "--host", "0.0.0.0", "--port", "8000", "--patients-root", "patients"]
