FROM python:3.12-slim

LABEL description="Simple TPS core library and CLI"

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app

COPY pyproject.toml README.md ./
COPY src ./src

RUN python -m pip install --upgrade pip setuptools wheel \
    && python -m pip install .

WORKDIR /workspace

ENTRYPOINT ["simple-tps"]
CMD ["--help"]
