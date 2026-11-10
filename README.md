# Jungle Gaming — Processador Distribuído de Apostas

Serviço financeiro distribuído para processar transações de apostas recebidas de múltiplos provedores. A infraestrutura, o domínio, os repositórios MikroORM, os endpoints HTTP e os consumidores SQS estão implementados; o processamento financeiro ocorre em transação SQL com lock por wallet e idempotência persistente.

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
latência, verificações de dependências do readiness e métricas de negócio.
`wager_transactions_total` e `wager_transaction_duplicates_total` são
contadores; `wager_retries_total` registra retries por origem/resultado;
`sqs_dead_letter_messages_total` conta mensagens na DLQ;
`database_lock_conflicts_total` conta conflitos detectados.
`wager_transaction_processing_duration_seconds`,
`http_server_request_duration_seconds` e `outbox_publish_delay_seconds` são
histogramas em segundos. `GET /health/live` verifica somente se o processo está
ativo; `GET /health/ready` verifica PostgreSQL e filas SQS.

A API HTTP inclui:

- `POST /wallets`: cria uma wallet; `playerId` é UUID, `currency` é ISO 4217 e
  `initialBalance` é opcional (padrão `"0.00"`). Saldo inicial positivo grava
  uma operação interna `OPENING` e um crédito no ledger na mesma transação SQL.
- `GET /wallets/:walletId`: consulta saldo e versão.
- `GET /wallets/:walletId/ledger?limit=50&cursor=...`: lista lançamentos com
  cursor opaco estável; `limit` aceita de 1 a 100.
- `POST /wagering/transactions`: submete BET, WIN, LOSS, REFUND ou ROLLBACK com
  `Idempotency-Key`.
- `GET /wagering/transactions/:transactionId` e
  `GET /wagering/transactions/by-external?providerId=...&externalTransactionId=...`:
  consultam uma operação pelas identidades interna ou externa.

O payload de transação usa valores monetários como strings decimais positivas,
moeda ISO 4217 e IDs UUID para wallet/jogador; REFUND/ROLLBACK exigem uma única
referência. `OPENING` não pode ser submetido por provedores. A criação duplicada
de wallet para jogador/moeda retorna 409 `WALLET_ALREADY_EXISTS`. A API ainda
não autentica provedores; a inclusão de autenticação deve ser feita por guard
ou middleware sem alterar os contratos de domínio.

Erros HTTP usam `{ error: { code, message, details? }, correlationId? }`, com
códigos estáveis: 400 `INVALID_REQUEST`, 404 `NOT_FOUND`, 409
`IDEMPOTENCY_CONFLICT` ou `WALLET_ALREADY_EXISTS`, 422 para rejeições de negócio,
202 `PROCESSING_PENDING`, 500 `PROCESSING_FAILED` terminal e 503
`SERVICE_UNAVAILABLE` transitório. Uma rejeição de negócio inclui o código
específico, por exemplo `INSUFFICIENT_BALANCE`; o replay conserva status, código
e saldo observados no processamento original.

Transações REFUND/ROLLBACK sem referência ficam em `PENDING_REFERENCE`. O
worker consulta pendências a cada segundo e agenda até cinco novas tentativas:
a primeira após um segundo, e as seguintes após 2, 4, 8 e 16 segundos. Se a
referência não chegar, a operação termina como `REJECTED` com
`REFERENCE_NOT_FOUND`, e o evento `WagerTransactionReferenceExpired` é gravado
na outbox na mesma transação SQL. Se a referência chegar, as regras de tipo,
valor, provedor, jogador, wallet, moeda e rodada são verificadas antes de
aplicar a reversão. Reprocessar não duplica lançamentos; o publisher da outbox
continua pendente de implementação.

O consumidor da fila FIFO `wager-transactions.fifo` aceita mensagens com este
formato:

```json
{
  "idempotencyKey": "provider-operation-123",
  "transaction": {
    "providerId": "provider-a",
    "externalTransactionId": "operation-123",
    "walletId": "00000000-0000-4000-8000-000000000001",
    "playerId": "00000000-0000-4000-8000-000000000002",
    "roundId": "round-1",
    "gameId": "game-1",
    "kind": "BET",
    "amount": "10.00",
    "currency": "BRL"
  }
}
```

O campo `transaction` usa a mesma validação e o mesmo caso de uso financeiro
da API. A inbox e os efeitos financeiros são confirmados atomicamente no
PostgreSQL; o consumidor remove a mensagem da fila somente após o commit.
Redeliveries do mesmo `MessageId` e payload são ignoradas com segurança. Falhas
não confirmadas recebem atrasos exponenciais de 1 a 16 segundos e, após cinco
entregas malsucedidas, a política da fila move a mensagem para
`wager-transactions-dlq.fifo`. Rejeições de negócio persistidas são
confirmadas; mensagens inválidas e falhas técnicas não são removidas. No
encerramento, o consumidor cancela o long-poll e aguarda o processamento em
andamento.

## Migrations

`bun run db:migrate` aplica migrations pendentes. `bun run db:migrate:down` reverte a migration mais recente. O executor usa uma transação PostgreSQL e um advisory lock para evitar execuções concorrentes. As migrations 001–005 criam a estrutura inicial, protegem reversões no ledger, alinham o versionamento da wallet, persistem o saldo original do replay e adicionam o agendamento de retries de referências.

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

Os testes e2e carregam `backend/.env` quando disponível e falham explicitamente se o banco ou as migrations necessárias não estiverem acessíveis. Testes PostgreSQL validam idempotência, API HTTP, inbox atômica e referências fora de ordem: chegada tardia e resolução, esgotamento das cinco tentativas, evento de expiração único e ausência de lançamentos duplicados. Testes unitários cobrem validação de mensagens, ACK após o processamento, retry sem ACK e shutdown do consumidor.

## Documentação

- [ARCHITECTURE.md](ARCHITECTURE.md) — decisões, limites e fluxos planejados da solução.

## Estado atual

`Money` usa centavos `BigInt`; `Wallet` protege moeda, saldo e versão; `WagerTransaction` controla estados, falhas, saldo original da resposta e retries limitados de referência; `WalletLedgerEntry` aplica movimentos imutáveis e reversões. Os marcos 10 e 11 processam operações em transação SQL com lock por wallet, hash SHA-256, replay que preserva a resposta original e conflito para payload divergente. O marco 12 integra os endpoints HTTP, o 14 resolve referências ausentes com backoff e expiração auditável na outbox, e o 15 consome a fila SQS com inbox atômica, retries e DLQ. O publisher da outbox ainda será conectado; autenticação continua fora do escopo atual.
