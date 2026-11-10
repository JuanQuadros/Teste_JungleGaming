# Jungle Gaming — Processador Distribuído de Apostas

Serviço financeiro distribuído para processar transações de apostas recebidas de múltiplos provedores. A infraestrutura, domínio e repositórios MikroORM estão preparados; o processamento financeiro ocorre em transação SQL com lock por wallet e idempotência persistente. A API e os workers ainda aguardam integração.

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

Logs HTTP são emitidos em JSON com `correlationId`, rota normalizada, método,
status e duração, sem registrar corpo ou valores financeiros. O cabeçalho
`X-Correlation-Id` recebido é aceito somente com caracteres e tamanho válidos;
caso contrário, a aplicação gera um UUID e devolve o identificador na resposta.
O endpoint `GET /metrics` expõe métricas Prometheus para requisições HTTP,
latência e verificações de dependências do readiness.

A camada de apresentação também fornece validação para o payload de transação
e para o header `Idempotency-Key`. O payload aceita somente BET, WIN, LOSS,
REFUND ou ROLLBACK; valores são strings decimais positivas, moeda é ISO 4217,
e REFUND/ROLLBACK exigem referência. O controller deve aplicar
`WagerTransactionRequestPipe` em `@Body()` e `IdempotencyKeyPipe` pelo decorator
`@IdempotencyKey()` antes de chamar o caso de uso.

Erros HTTP usam `{ error: { code, message, details? }, correlationId? }`, com
códigos estáveis: 400 `INVALID_REQUEST`, 409 `IDEMPOTENCY_CONFLICT`, 422 para
rejeições de negócio, 202 `PROCESSING_PENDING`, 500 `PROCESSING_FAILED` terminal
e 503 `SERVICE_UNAVAILABLE` transitório. O mapeador de resultado de domínio
está preparado para ser usado pelos endpoints de transação.

## Migrations

`bun run db:migrate` aplica migrations pendentes. `bun run db:migrate:down` reverte a migration mais recente. O executor usa uma transação PostgreSQL e um advisory lock para evitar execuções concorrentes. As migrations 001–004 criam a estrutura inicial, protegem reversões no ledger, alinham o versionamento da wallet e persistem o saldo da resposta original para replay idempotente.

## Testes e compilação

Na pasta `backend/`:

```powershell
bun run build
bun run test
```

Os testes de integração usam PostgreSQL e validam mapeamentos e reidratação. Com o PostgreSQL do Compose saudável e as variáveis de `backend/.env` configuradas, aplique as migrations e execute:

```powershell
bun run db:migrate
bun run test:e2e
```

Os testes e2e carregam `backend/.env` quando disponível e falham explicitamente se o banco ou as migrations necessárias não estiverem acessíveis. A idempotência é validada com PostgreSQL real para chamadas concorrentes e sequenciais, replay do saldo original após operações posteriores e reinicialização, conflito de payload sem efeitos financeiros adicionais.

## Documentação

- [ARCHITECTURE.md](ARCHITECTURE.md) — decisões, limites e fluxos planejados da solução.

## Estado atual

`Money` usa centavos `BigInt`; `Wallet` protege moeda, saldo e versão; `WagerTransaction` controla estados, falhas e o saldo registrado na resposta original; `WalletLedgerEntry` aplica movimentos imutáveis e reversões. Os marcos 10 e 11 processam BET, WIN, LOSS, REFUND e ROLLBACK em transação SQL, com lock por wallet, hash SHA-256 do payload de negócio, replay idêntico que preserva a resposta financeira original e conflito para reutilização da chave com dados diferentes. A validação e o mapeamento de erros da API aguardam integração aos endpoints. Outbox e processamento SQS ainda serão conectados aos casos de uso.
