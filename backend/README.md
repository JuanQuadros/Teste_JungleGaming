# Backend

O backend usa Bun, TypeScript estrito, NestJS, MikroORM e PostgreSQL. A lógica financeira do desafio ainda não foi implementada; esta etapa cobre configuração, conexão e estrutura inicial do banco.

## Configurar

Na raiz do repositório, copie `docker/.env.example` para `docker/.env` e informe um token válido do LocalStack. Depois copie `backend/.env.example` para `backend/.env`. Os valores PostgreSQL dos dois arquivos devem corresponder.

## Executar

Na raiz do repositório:

```powershell
docker compose --env-file docker/.env -f docker/compose.yaml up -d
```

Na pasta `backend/`:

```powershell
bun install
bun run db:migrate
bun run start:dev
```

`GET /health/live` verifica se a API responde. `GET /health/ready` consulta PostgreSQL e as duas filas SQS.

## Migrations

- `bun run db:migrate` aplica migrations pendentes.
- `bun run db:migrate:down` reverte a migration mais recente.

O executor usa uma transação PostgreSQL e um advisory lock para evitar que instâncias concorrentes executem migrations ao mesmo tempo.
