# Jungle Gaming — Processador Distribuído de Apostas

Serviço backend para processamento de transações financeiras de apostas, desenvolvido como projeto técnico para demonstrar consistência financeira, idempotência, concorrência, processamento assíncrono e recuperação após falhas.

O sistema recebe operações por API HTTP ou Amazon SQS e utiliza o PostgreSQL como fonte de verdade para saldos, transações, histórico financeiro e eventos de integração.

## Tecnologias

- **Runtime:** Bun 1.x
- **Linguagem:** TypeScript (strict)
- **Framework:** NestJS
- **Banco de dados:** PostgreSQL
- **ORM:** MikroORM
- **Mensageria:** AWS SQS
- **Ambiente local da mensageria:** LocalStack
- **Containers:** Docker Compose
- **Testes:** Vitest
- **Controle de versão:** Git

## Funcionalidades

- Criação e consulta de wallets.
- Processamento de BET, WIN, LOSS, REFUND e ROLLBACK.
- Controle de saldo com precisão monetária usando `BigInt`.
- Histórico financeiro imutável (Ledger).
- Idempotência persistente com chave e hash do payload.
- Controle de concorrência com locks PostgreSQL.
- Processamento assíncrono por SQS FIFO.
- Deduplicação de mensagens recebidas por Inbox.
- Publicação de eventos por Outbox.
- Contratos de eventos de integração versionados.
- Retry de operações que aguardam referências.
- Recuperação de mensagens e encaminhamento para DLQ.
- Reconciliação entre saldo da wallet e histórico financeiro.
- Logs estruturados, correlation ID, métricas e health checks.

## Arquitetura

O projeto segue uma separação de responsabilidades em camadas:

- **Domain:** regras de negócio, entidades e objetos de valor.
- **Application:** casos de uso e coordenação das operações.
- **Infrastructure:** PostgreSQL, MikroORM, SQS, persistência e workers.
- **Presentation:** controllers, DTOs, validações e contratos HTTP.

A API HTTP e o consumidor SQS compartilham os mesmos casos de uso financeiros.

O PostgreSQL é a autoridade final para a consistência das operações. Saldo, transação, ledger e eventos da outbox são persistidos na mesma transação SQL. Quando a operação é recebida pelo SQS, o registro da inbox também participa dessa transação.

A publicação da outbox ocorre separadamente, depois do commit financeiro.

Consulte [ARCHITECTURE.md](ARCHITECTURE.md) para conhecer as decisões técnicas, os fluxos e as garantias de consistência.

## Eventos de integração

Os eventos publicados utilizam um envelope versionado com os campos:

- `eventId`
- `eventType`
- `aggregateId`
- `correlationId`
- `causationId` (opcional)
- `occurredAt`
- `version`
- `data`

Eventos implementados:

- `WagerTransactionProcessed`
- `WagerTransactionRejected`
- `WagerTransactionPendingReference`
- `WagerTransactionReferenceExpired`
- `WalletBalanceChanged`

A publicação utiliza entrega **at-least-once**. Portanto, consumidores externos devem deduplicar mensagens usando `eventId`.

## API HTTP

| Método | Endpoint | Descrição |
|---|---|---|
| POST | `/wallets` | Cria uma wallet |
| GET | `/wallets/:walletId` | Consulta uma wallet |
| GET | `/wallets/:walletId/ledger` | Consulta o histórico financeiro |
| POST | `/wallets/:walletId/reconciliation` | Reconcilia saldo e ledger |
| POST | `/wagering/transactions` | Submete uma transação |
| GET | `/wagering/transactions/:transactionId` | Consulta uma transação |
| GET | `/wagering/transactions/by-external` | Consulta por identidade externa |

A submissão de transações exige o header `Idempotency-Key`.

A operação `OPENING` é interna e utilizada na criação de wallets com saldo inicial positivo. Ela não pode ser submetida por provedores externos.

A API ainda não implementa autenticação de provedores. Essa funcionalidade permanece fora do escopo atual.

## Pré-requisitos

- Bun 1.x.
- Docker Desktop com mecanismo Linux iniciado.
- Token válido do LocalStack para a imagem configurada no Docker Compose.
- Git.

## Configuração local

Na raiz do repositório, crie os arquivos de ambiente:

```powershell
# Cria o ambiente do Docker a partir do exemplo.
Copy-Item docker\.env.example docker\.env

# Cria o ambiente do backend a partir do exemplo.
Copy-Item backend\.env.example backend\.env
```

Edite `docker/.env` e informe o token exigido pelo LocalStack.

Confira se as configurações de banco em `backend/.env` correspondem às configurações de `docker/.env`.

Os arquivos `.env` locais não devem ser enviados ao Git. Não versione tokens ou senhas.

## Iniciar PostgreSQL e LocalStack

Execute na raiz do projeto:

```powershell
# Inicia os serviços definidos no Docker Compose.
docker compose --env-file docker/.env -f docker/compose.yaml up -d

# Confere o estado dos containers.
docker compose --env-file docker/.env -f docker/compose.yaml ps
```

O ambiente local configura as filas:

- `wager-transactions.fifo`
- `wager-transactions-dlq.fifo`
- `wager-events.fifo`
- `wager-events-dlq.fifo`

Aguarde os serviços ficarem saudáveis antes de iniciar o backend.

## Instalar e iniciar o backend

Entre na pasta `backend/`:

```powershell
# Acessa o backend.
Set-Location backend

# Instala as dependências.
bun install

# Aplica as migrations pendentes.
bun run db:migrate

# Inicia a aplicação em desenvolvimento.
bun run start:dev
```

A API fica disponível em `http://localhost:3000`.

## Health checks e métricas

Endpoints disponíveis:

- `GET /health/live`: verifica se o processo está ativo.
- `GET /health/ready`: verifica PostgreSQL e filas SQS.
- `GET /metrics`: expõe métricas Prometheus.

O middleware HTTP valida o cabeçalho `X-Correlation-Id`, propaga o identificador na resposta e gera um UUID quando o valor recebido é inválido ou inexistente.

Os logs são estruturados e evitam registrar payloads e valores financeiros.

## Testes e compilação

Na pasta `backend/`:

```powershell
# Verifica a compilação TypeScript/NestJS.
bun run build

# Executa os testes unitários.
bun run test

# Executa os testes de integração e ponta a ponta.
bun run test:e2e

# Executa o lint.
bun run lint
```

Os testes E2E dependem de PostgreSQL e LocalStack reais em containers.

A suíte cobre, entre outros cenários:

- Idempotência sequencial e concorrente.
- Concorrência entre operações financeiras.
- Persistência e reidratação de entidades.
- Atomicidade de transações e inbox.
- Publicação e recuperação da outbox.
- Retry e redelivery de mensagens.
- Encaminhamento para DLQ.
- Reconciliação do saldo com o ledger.
- Referências antecipadas de REFUND e ROLLBACK.
- Reversão de REFUND por ROLLBACK.
- Concorrência entre publishers e consumers.

### Última validação registrada

Na execução mais recente informada:

| Verificação | Resultado |
|---|---:|
| Build | Aprovado |
| Testes unitários | 124/124 |
| Arquivos de testes unitários | 15/15 |
| Testes E2E | 39/39 |
| Arquivos de testes E2E | 10/10 |
| Total de testes | 163/163 |

Esses resultados representam uma execução registrada durante o desenvolvimento. Para validar outro ambiente ou uma versão posterior, execute novamente os comandos acima.

## Documentação

- [ARCHITECTURE.md](ARCHITECTURE.md): arquitetura, decisões técnicas, fluxos, invariantes e limitações.
- `GUIA.md`: material pessoal de estudo e preparação para apresentação técnica. Não faz parte da documentação pública do projeto.

## Limitações conhecidas

- Autenticação de provedores não implementada.
- A publicação PostgreSQL/SQS não é exactly-once.
- Consumidores externos precisam deduplicar eventos por `eventId`.
- A reconciliação identifica divergências, mas não corrige automaticamente os dados.
- O cenário de múltiplos consumers foi testado com instâncias independentes no mesmo processo, não com três processos NestJS implantados separadamente.
- O ambiente E2E depende de PostgreSQL, Docker e LocalStack disponíveis.