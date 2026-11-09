# Backend local setup

## Start the local services

From the repository root, start PostgreSQL and LocalStack (the Compose environment file is kept under `docker/`):

```powershell
docker compose --env-file docker/.env -f docker/compose.yaml up -d
```

Wait for both services to become healthy. LocalStack creates `wager-transactions.fifo` and `wager-transactions-dlq.fifo` during startup.

## Configure and run the API

Copy `.env.example` to `.env` in this directory and set the PostgreSQL values to match `docker/.env`. The local `.env` is ignored by Git.

```powershell
bun install
bun run db:migrate
bun run start:dev
```

The API listens on port 3000 by default. `GET /health/live` checks the process, and `GET /health/ready` checks PostgreSQL.

## Migrations

Migrations are versioned and reversible. Apply the initial schema with `bun run db:migrate`; revert it with `bun run db:migrate:down`. Each migration and its registry update run in one PostgreSQL transaction guarded by an advisory lock.
