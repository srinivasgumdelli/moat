FROM python:3.12-slim AS base

WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential && rm -rf /var/lib/apt/lists/*

COPY pyproject.toml .
RUN pip install --no-cache-dir .

FROM python:3.12-slim
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends \
    fonts-dejavu-core && rm -rf /var/lib/apt/lists/*
COPY --from=base /usr/local/lib/python3.12/site-packages /usr/local/lib/python3.12/site-packages
COPY --from=base /usr/local/bin /usr/local/bin
COPY intel/ intel/
COPY config.yaml .

VOLUME /app/data
ENV PYTHONUNBUFFERED=1

ENTRYPOINT ["python", "-m", "intel"]
CMD ["run"]
