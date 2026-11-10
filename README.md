# Jungle Gaming — Processador Distribuído de Apostas

Serviço financeiro distribuído para processar transações de apostas recebidas de múltiplos provedores. A infraestrutura está preparada e os componentes de domínio `Money`, `Wallet` e `WagerTransaction` já foram implementados. Os fluxos financeiros ainda não foram implementados.

## Tecnologias

- Bun 1.x, TypeScript estrito e NestJS
- PostgreSQL com MikroORM
- AWS SQS local pelo LocalStack
- Docker Compose
- Vitest

## Pré-requisitos

- Bun 1.x instalado
- Docker Desktop aberto e com o mecanismo Linux iniciado
- Token válido do LocalStack para a imagem configurada no Compose

## Configuração local

Na raiz do repositório, crie o arquivo de ambiente do Docker a partir do exemplo:

```powershell
Copy-Item docker\.env.example docker\.env
```

Edite `docker/.env` e informe seu token do LocalStack. O exemplo já define os valores locais do PostgreSQL.

Crie o arquivo de ambiente do backend:

```powershell
Copy-Item backend\.env.example backend\.env
```

Os valores de banco em `backend/.env` devem corresponder a `docker/.env`. O host e a porta são `localhost:5432`, pois o backend roda na máquina e o banco no container.

Os arquivos `.env` locais são ignorados pelo Git. Não versione tokens ou senhas.

## Iniciar PostgreSQL e LocalStack

Execute na raiz do repositório:

```powershell
docker compose --env-file docker/.env -f docker/compose.yaml up -d
docker compose --env-file docker/.env -f docker/compose.yaml ps
```

Espere os dois serviços ficarem saudáveis. O LocalStack cria automaticamente as filas `wager-transactions.fifo` e `wager-transactions-dlq.fifo`.

## Instalar, migrar e iniciar o backend

```powershell
Set-Location backend
bun install
bun run db:migrate
bun run start:dev
```

A API fica disponível em `http://localhost:3000`.

## Verificações rápidas

Em outro terminal:

```powershell
Invoke-RestMethod http://localhost:3000/health/live
Invoke-RestMethod http://localhost:3000/health/ready
```

O endpoint de prontidão responde somente quando PostgreSQL, fila de transações e fila DLQ estão acessíveis.

## Migrations

`bun run db:migrate` aplica migrations pendentes. `bun run db:migrate:down` reverte a migration mais recente. O executor usa uma transação PostgreSQL e um advisory lock para evitar execuções concorrentes. A migration inicial cria a estrutura base de wallets, transações, ledger, inbox e outbox; ela ainda não implementa as regras financeiras.

## Testes e compilação

Na pasta `backend/`:

```powershell
bun run build
bun run test
bun run test:e2e
```

Os testes de integração exigidos pelo desafio ainda serão adicionados quando a implementação de negócio começar.

## Documentação

- [ARCHITECTURE.md](ARCHITECTURE.md) — decisões, limites e fluxos planejados da solução.

## Estado atual

`Money` representa valores com centavos `BigInt`; `Wallet` protege moeda, saldo não negativo e versão; `WagerTransaction` controla estados explícitos e códigos estáveis de falha; `WalletLedgerEntry` registra movimentos imutáveis e valida as regras de reversão. A migration 002 vincula cada reversão a um lançamento da mesma wallet e impede mais de uma reversão por lançamento original. Os casos de uso financeiros, a persistência transacional integrada, a idempotência e o processamento assíncrono ainda não foram implementados.
