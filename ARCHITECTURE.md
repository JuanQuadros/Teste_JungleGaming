# Arquitetura — Jungle Gaming

## Estado e escopo

Este documento registra as decisões que orientam a implementação do desafio. A infraestrutura, os componentes de domínio, entidades, repositórios, processamento financeiro e endpoints HTTP mínimos estão implementados. A API e o processamento financeiro usam transações SQL com lock por wallet; os workers ainda aguardam integração.

O objetivo é processar operações de apostas de múltiplos provedores com entrega at-least-once, concorrência entre instâncias e recuperação após falhas, preservando a consistência financeira.

## Stack

- Bun 1.x como runtime, gerenciador de pacotes e executor de testes.
- TypeScript em modo estrito e NestJS para a aplicação HTTP e composição de módulos.
- PostgreSQL como autoridade para saldo, idempotência, ledger, inbox e outbox.
- MikroORM para conexão e persistência; migrations versionadas para mudanças de schema.
- AWS SQS, executado localmente pelo LocalStack, para processamento assíncrono.
- Docker Compose para PostgreSQL e LocalStack no ambiente de desenvolvimento.

## Limites entre camadas

As dependências devem apontar para dentro, em direção ao domínio:

1. **Domínio:** `Money`, `Wallet`, `WagerTransaction` e `WalletLedgerEntry` existem sem dependência de NestJS, MikroORM, SQS ou tipos monetários do banco.
2. **Aplicação:** portas de repositório definem como localizar e persistir os aggregates; casos de uso coordenam validação, transação financeira, idempotência e criação de wallet. Publicação de eventos ainda será integrada.
3. **Infraestrutura:** entidades MikroORM mapeiam as tabelas financeiras, inbox e outbox. Repositórios MikroORM convertem as entidades para o domínio; transações PostgreSQL e migrations dão suporte ao processamento financeiro. Workers SQS e observabilidade de negócio ainda serão implementados.
4. **Apresentação:** controllers HTTP para wallets, ledger e transações, DTOs, validação de entrada e mapeamento consistente de respostas e erros.

## API HTTP

O marco 12 expõe `POST /wallets`, `GET /wallets/:walletId`,
`GET /wallets/:walletId/ledger`, `POST /wagering/transactions`,
`GET /wagering/transactions/:transactionId` e a consulta por
`providerId` + `externalTransactionId` em
`GET /wagering/transactions/by-external`. Os controllers recebem e devolvem
contratos HTTP explícitos; entidades MikroORM não são expostas.

Wallets novas começam com saldo zero. Quando `initialBalance` é positivo, a
criação da wallet, a transação interna `OPENING` e o lançamento de crédito são
persistidos na mesma transação SQL. A unicidade de `(playerId, currency)` é
mantida no banco e conflitos são retornados como 409 `WALLET_ALREADY_EXISTS`.
O histórico do ledger usa ordenação estável por timestamp truncado a
milissegundos e UUID, com cursor opaco Base64URL e limite configurável entre 1
e 100.

A submissão de transações exige `Idempotency-Key`; o pipe valida a chave e o
payload antes do caso de uso financeiro. `OPENING` permanece interno. A API
ainda não autentica provedores; guards ou middleware são o ponto de extensão
para autenticação sem acoplar credenciais ao domínio.

O domínio não deve conhecer detalhes de transporte ou persistência. A aplicação coordena portas; a infraestrutura implementa essas portas.

## Representação monetária

Valores entram e saem da API como strings decimais, por exemplo `"25.00"`. O `Money` implementado armazena centavos em `BigInt`, sem converter dinheiro para `number` ou ponto flutuante, e serializa sempre com duas casas. Sua faixa respeita `numeric(20, 2)`, que é o tipo usado no schema inicial do PostgreSQL; o banco nunca usa `real` ou `double precision` para valores monetários.

`Money` é imutável, valida escala e código de moeda e rejeita valores negativos nos contratos de criação. Operações do domínio, como `negate` e `subtract`, podem produzir negativos sem alterar a instância original. A moeda permanece parte do modelo para validar incompatibilidades, mesmo que o escopo inicial use somente BRL.

`Wallet` é o aggregate que associa identificador e jogador a uma moeda, saldo e versão. A abertura começa com saldo zero e versão zero; crédito e débito aceitam somente valores positivos da mesma moeda e avançam a versão uma vez por alteração aceita. Débito acima do saldo é rejeitado sem alterar estado. O banco usa `INTEGER` para a versão; a wallet valida o limite desse tipo e a migration 003 alinha a versão inicial zero ao schema.

Entidades MikroORM guardam valores `NUMERIC(20, 2)` como strings decimais e mantêm UUIDs como identificadores escalares. Os repositórios convertem valores monetários para `Money` ao ler e de volta para strings ao persistir. Eles agendam mudanças no Unit of Work atual e não fazem `flush` ou `commit`; o caso de uso e a unidade de trabalho transacional coordenam a confirmação. O schema continua sendo alterado apenas pelo executor explícito de migrations.

## Transação financeira e concorrência

O PostgreSQL é a autoridade final para concorrência e invariantes. A unidade de serialização é `walletId`; não haverá lock global.

**Implementado nos marcos 10 e 11:** `MikroOrmWalletTransactionUnitOfWork` abre uma transação SQL, serializa a mesma chave de idempotência com advisory lock e, para operação nova, bloqueia a linha da wallet com lock pessimista (`SELECT ... FOR UPDATE`). O hash SHA-256 é calculado sobre os campos de negócio. Chave e hash iguais retornam a transação persistida sem repetir efeitos; chave igual com hash diferente gera conflito. Para novas operações, saldo, transação e ledger são gravados no mesmo Unit of Work. Erros técnicos revertem alterações; rejeições e pendências são persistidas sem movimento de saldo. Chaves e wallets diferentes podem avançar em paralelo. A outbox será conectada no marco 16.

Constraints no banco complementam as validações do domínio: unicidade de wallet por jogador/moeda, idempotência e identidade externa, saldo não negativo, no máximo um lançamento por transação, no máximo uma reversão por lançamento original e imutabilidade do ledger. `WalletLedgerEntry` valida direção, valor e saldos anterior/posterior. BET gera débito; WIN e OPENING processados geram crédito; LOSS e transações não processadas não geram lançamento. REFUND só reverte BET processada; ROLLBACK pode reverter uma operação processada com lançamento original, exceto REFUND e ROLLBACK. Ambos exigem valor integral e referência do mesmo provedor, jogador, wallet, moeda e rodada. A reversão cria um novo lançamento oposto, sem alterar o original. A consistência entre o saldo materializado e a soma do ledger deve ser mantida por cada caso de uso transacional e conferida por reconciliação.

## Idempotência e identidade de transação

O header `Idempotency-Key` é a fonte da verdade e tem unicidade persistente no banco. A aplicação calcula SHA-256 sobre campos de negócio em ordem fixa; metadados de transporte, ID interno e o próprio hash não participam do cálculo. Um advisory lock PostgreSQL por chave serializa chamadas concorrentes antes da consulta ao registro existente. A operação nova grava transação, saldo e ledger dentro da mesma transação SQL.

- Mesma chave e mesmo hash: retornar a transação persistida como replay, sem repetir efeitos.
- Mesma chave e hash diferente: lançar conflito estável, sem alterar saldo.
- Identidade externa: unicidade por `(providerId, externalTransactionId)`.
- O saldo observado na resposta original é persistido em `response_balance`; replays retornam esse valor mesmo que operações posteriores tenham alterado o saldo atual da wallet.

Migration 004 adiciona `response_balance` como valor monetário não negativo e anulável para compatibilidade dos registros existentes. Testes PostgreSQL cobrem chamadas concorrentes e sequenciais, replay após alteração posterior do saldo, conflito de payload sem novos efeitos e replay após reinicialização do ORM. Chaves em memória e deduplicação do broker são apenas otimizações, nunca garantias.

## Referências e transições fora de ordem

BET, WIN, LOSS, REFUND e ROLLBACK são tratados pelo caso de uso financeiro, já integrado à entrada HTTP; o consumidor SQS ainda será integrado. REFUND e ROLLBACK exigem referência válida do mesmo provedor, jogador, wallet, moeda e rodada. Referência ainda ausente produz `PENDING_REFERENCE`, sem movimento de saldo, para reprocessamento com backoff e limite documentado.

`WagerTransaction` começa em `PENDING` e pode aguardar referência, voltar ao processamento ou encerrar como `PROCESSED`, `REJECTED` ou `FAILED`. Estados terminais não aceitam novas transições. A reidratação valida e restaura o estado persistido diretamente, sem repetir o histórico de transições. Rejeições possuem códigos estáveis para saldo insuficiente, referência inválida e reversão que causaria saldo negativo; falhas técnicas usam `PROCESSING_FAILED`. `OPENING` existe no modelo persistido, mas a factory de entrada externa exclui esse tipo: sua criação fica reservada ao código interno. As interfaces HTTP e SQS ainda deverão respeitar essa separação.

Reversões não podem acontecer mais de uma vez nem tornar o saldo negativo.

## SQS, inbox e outbox

O consumidor grava `(consumerName, messageId)` na inbox na mesma transação SQL que processa a operação. O ack ocorre somente depois do commit. Redelivery não repete efeitos; erros de negócio são terminais, falhas transitórias são tentadas novamente e falhas permanentes/limite excedido seguem para a DLQ.

Os eventos de integração são inseridos na outbox dentro da transação financeira. Publishers concorrentes reservam registros pendentes no banco, publicam somente após o commit original e marcam sucesso ou agendam retry com backoff. Publicação duplicada é esperada e deve ser segura para consumidores.

Eventos mínimos: `WagerTransactionProcessed`, `WagerTransactionRejected`, `WagerTransactionPendingReference` e `WalletBalanceChanged` somente quando o saldo muda.

## API, autenticação e health checks

Controllers HTTP convertem contratos externos para casos de uso e traduzem erros para respostas estáveis. Payload inválido, conflito de idempotência, rejeição de negócio, processamento pendente e falha transitória devem ser distinguíveis.

A camada de apresentação fornece um pipe para validar o corpo da operação e um decorator com pipe para validar `Idempotency-Key`. O controller deve aplicá-los antes do caso de uso. O payload aceita apenas tipos externos; valores monetários são strings decimais positivas, a moeda deve ser ISO 4217 e REFUND/ROLLBACK exigem referência. O filtro global retorna `{ error: { code, message, details? }, correlationId? }`, sem expor mensagens internas ou payloads financeiros. Mapeamentos estáveis: 400 `INVALID_REQUEST`, 409 `IDEMPOTENCY_CONFLICT`, 422 rejeição de negócio, 202 `PROCESSING_PENDING`, 500 falha técnica terminal e 503 falha transitória. Os endpoints ainda serão conectados a esses componentes.

Autenticação não vale pontos no desafio e é opcional. A decisão atual é não implementá-la nesta etapa. Se continuar fora do escopo, documentar o desenho futuro e deixar um ponto de extensão para identidade de provedor/guard. Não criar autenticação própria com tabela e hash de senha. Health checks ficam abertos; mensagens de fila são canal interno confiável, mas ainda passam pelas validações do domínio.

`/health/live` verifica somente se o processo responde. `/health/ready` verifica PostgreSQL e as filas SQS necessárias.

## Migrations e estado atual do banco

Migrations são versionadas, transacionais e reversíveis. O executor atual guarda versões em `schema_migrations` e usa advisory lock PostgreSQL para serializar execuções concorrentes.

A migration `001-initial-structure` cria a estrutura inicial de wallets, transações, ledger, inbox e outbox; `002-ledger-reversals` vincula reversões a lançamentos originais; `003-wallet-version-zero` alinha a versão inicial do banco com o aggregate. Os marcos 10 e 11 usam repositórios na mesma transação para atualizar wallet, transação e ledger atomicamente e assegurar replay idempotente. A integração com a outbox continua pendente.

## Observabilidade e testes

Logs HTTP estruturados em JSON incluem `correlationId`, método, rota normalizada, status e duração, sem registrar payloads ou valores financeiros. O cabeçalho `X-Correlation-Id` é validado e propagado na resposta; valores inválidos são substituídos por UUID. `GET /metrics` expõe métricas Prometheus: `http_server_requests_total` (contador por método, rota e status), `http_server_request_duration_seconds` (histograma em segundos) e `health_dependency_checks_total` (contador por dependência e resultado). Métricas de transações por status, duplicatas, retries, mensagens na DLQ, conflitos de lock e atraso da outbox ainda dependem da implementação dos respectivos fluxos e devem ser instrumentadas neles.

Os testes unitários de `Money`, `Wallet`, `WagerTransaction`, `WalletLedgerEntry` e da infraestrutura de métricas/correlação cobrem precisão monetária, invariantes de saldo e versionamento, transições de estado, terminalidade, reidratação, aritmética dos lançamentos, regras de reversão e exposição de métricas. Testes com PostgreSQL validam repositórios, concorrência e endpoints HTTP, incluindo abertura atômica com `OPENING`, replays, consultas de transação e paginação do ledger. Ainda serão necessários testes de redelivery, falhas após commit e publishers concorrentes. O invariante final é `wallet.balance == saldo reconstruído pelo ledger`.

## Decisões ainda revisáveis

- Limite de tentativas e TTL para referências pendentes.
- Taxonomia completa de failure codes e mapeamento de status HTTP.
- Política de retry/backoff para consumidores e publishers.
- Integração do versionamento da wallet com a gravação concorrente no PostgreSQL.
- Autenticação externa, caso seja implementada.
