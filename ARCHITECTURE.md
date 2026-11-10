# Arquitetura — Jungle Gaming

## Estado e escopo

Este documento registra as decisões que orientam a implementação do desafio. A infraestrutura, os componentes de domínio, entidades, repositórios, processamento financeiro, endpoints HTTP, consumidor SQS e publisher da outbox estão implementados. A API e o processamento financeiro usam transações SQL com lock por wallet.

O objetivo é processar operações de apostas de múltiplos provedores com entrega at-least-once, concorrência entre instâncias e recuperação após falhas, preservando a consistência financeira. A API HTTP e o consumidor SQS compartilham os mesmos casos de uso; o consumidor confirma a mensagem somente após a transação financeira e a inbox serem commitadas.

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
2. **Aplicação:** portas de repositório definem como localizar e persistir os aggregates; casos de uso coordenam validação, transação financeira, idempotência e criação de wallet.
3. **Infraestrutura:** entidades MikroORM mapeiam as tabelas financeiras, inbox e outbox. Repositórios MikroORM convertem as entidades para o domínio; transações PostgreSQL e migrations dão suporte ao processamento financeiro. O consumidor SQS processa mensagens FIFO com inbox persistente e ACK após commit; o publisher entrega eventos da outbox com leases persistidos e retries.
4. **Apresentação:** controllers HTTP para wallets, ledger e transações, DTOs, validação de entrada e mapeamento consistente de respostas e erros.

## API HTTP

O marco 12 expõe `POST /wallets`, `GET /wallets/:walletId`,
`GET /wallets/:walletId/ledger`, `POST /wagering/transactions`,
`GET /wagering/transactions/:transactionId` e a consulta por
`providerId` + `externalTransactionId` em
`GET /wagering/transactions/by-external`. O marco 17 adiciona
`POST /wallets/:walletId/reconciliation`. Os controllers recebem e devolvem
contratos HTTP explícitos; entidades MikroORM não são expostas.

Wallets novas começam com saldo zero. Quando `initialBalance` é positivo, a
criação da wallet, a transação interna `OPENING` e o lançamento de crédito são
persistidos na mesma transação SQL. A unicidade de `(playerId, currency)` é
mantida no banco e conflitos são retornados como 409 `WALLET_ALREADY_EXISTS`.
O histórico do ledger usa ordenação estável por timestamp truncado a
milissegundos e UUID, com cursor opaco Base64URL e limite configurável entre 1
e 100.

A reconciliação soma os créditos e subtrai os débitos imutáveis do ledger com
aritmética `NUMERIC` exata, compara o resultado com o saldo materializado e
retorna ambos os saldos, a diferença (saldo da wallet menos saldo do ledger),
consistência e quantidade de lançamentos verificados. Uma divergência é
registrada em log estruturado e na métrica
`wallet_reconciliations_total`; a operação é somente de leitura e nunca corrige
automaticamente wallet ou ledger.

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

**Implementado nos marcos 10, 11 e 16:** `MikroOrmWalletTransactionUnitOfWork` abre uma transação SQL, serializa a mesma chave de idempotência com advisory lock e, para operação nova, bloqueia a linha da wallet com lock pessimista (`SELECT ... FOR UPDATE`). O hash SHA-256 é calculado sobre os campos de negócio. Chave e hash iguais retornam a transação persistida sem repetir efeitos; chave igual com hash diferente gera conflito. Para novas operações, saldo, transação, ledger e eventos de integração são gravados no mesmo Unit of Work. Erros técnicos revertem alterações; rejeições e pendências são persistidas sem movimento de saldo. Chaves e wallets diferentes podem avançar em paralelo.

Constraints no banco complementam as validações do domínio: unicidade de wallet por jogador/moeda, idempotência e identidade externa, saldo não negativo, no máximo um lançamento por transação, no máximo uma reversão por lançamento original e imutabilidade do ledger. `WalletLedgerEntry` valida direção, valor e saldos anterior/posterior. BET gera débito; WIN e OPENING processados geram crédito; LOSS e transações não processadas não geram lançamento. REFUND só reverte BET processada; ROLLBACK pode reverter uma operação processada com lançamento original, exceto REFUND e ROLLBACK. Ambos exigem valor integral e referência do mesmo provedor, jogador, wallet, moeda e rodada. A reversão cria um novo lançamento oposto, sem alterar o original. A consistência entre o saldo materializado e a soma do ledger deve ser mantida por cada caso de uso transacional e conferida por reconciliação.

## Idempotência e identidade de transação

O header `Idempotency-Key` é a fonte da verdade e tem unicidade persistente no banco. A aplicação calcula SHA-256 sobre campos de negócio em ordem fixa; metadados de transporte, ID interno e o próprio hash não participam do cálculo. Um advisory lock PostgreSQL por chave serializa chamadas concorrentes antes da consulta ao registro existente. A operação nova grava transação, saldo e ledger dentro da mesma transação SQL.

- Mesma chave e mesmo hash: retornar a transação persistida como replay, sem repetir efeitos.
- Mesma chave e hash diferente: lançar conflito estável, sem alterar saldo.
- Identidade externa: unicidade por `(providerId, externalTransactionId)`.
- O saldo observado na resposta original é persistido em `response_balance`; replays retornam esse valor mesmo que operações posteriores tenham alterado o saldo atual da wallet.

Migration 004 adiciona `response_balance` como valor monetário não negativo e anulável para compatibilidade dos registros existentes. Testes PostgreSQL cobrem chamadas concorrentes e sequenciais, replay após alteração posterior do saldo, conflito de payload sem novos efeitos e replay após reinicialização do ORM. Chaves em memória e deduplicação do broker são apenas otimizações, nunca garantias.

## Referências e transições fora de ordem

BET, WIN, LOSS, REFUND e ROLLBACK são tratados pelo caso de uso financeiro, integrado às entradas HTTP e SQS. REFUND e ROLLBACK exigem referência válida do mesmo provedor, jogador, wallet, moeda e rodada. Referência ainda ausente produz `PENDING_REFERENCE`, sem movimento de saldo, para reprocessamento com backoff e limite documentado.

O worker `PendingReferenceRetryWorker` varre pendências a cada segundo, com lotes de até 50 itens. A primeira tentativa é agendada para um segundo após a submissão pendente; são permitidos cinco retries, com esperas exponenciais de 2, 4, 8 e 16 segundos após os quatro primeiros retries sem referência. `reference_attempts` e `reference_next_attempt_at` são persistidos pela migration 005, portanto o agendamento sobrevive a reinícios. O lock de idempotência e o lock pessimista da wallet serializam cada retry com novas operações e com outros workers.

Quando a referência aparece, o mesmo caso de uso financeiro valida seu estado processado, tipo elegível, lançamento original, valor integral e identidade de provedor, jogador, wallet, moeda e rodada antes de aplicar a reversão. O aggregate existente é atualizado; a operação não é inserida novamente. Após cinco retries sem referência, a transação é rejeitada com `REFERENCE_NOT_FOUND`, sem movimento no saldo/ledger, e `WagerTransactionReferenceExpired` é inserido na outbox no mesmo commit. Assim, a transição terminal e o evento são atômicos e um retry concorrente não duplica nem o evento nem um lançamento.

`WagerTransaction` começa em `PENDING` e pode aguardar referência, voltar ao processamento ou encerrar como `PROCESSED`, `REJECTED` ou `FAILED`. Estados terminais não aceitam novas transições. A reidratação valida e restaura o estado persistido diretamente, sem repetir o histórico de transições. Rejeições possuem códigos estáveis para saldo insuficiente, referência inválida e reversão que causaria saldo negativo; falhas técnicas usam `PROCESSING_FAILED`. `OPENING` existe no modelo persistido, mas a factory de entrada externa exclui esse tipo: a API e a fila validam e rejeitam esse tipo, e a criação fica reservada ao código interno.

Reversões não podem acontecer mais de uma vez nem tornar o saldo negativo.

## SQS, inbox e outbox

O consumidor do marco 15 recebe uma mensagem por long-poll da fila FIFO `wager-transactions.fifo`. O corpo contém `idempotencyKey` e `transaction`; a validação é compartilhada com a entrada HTTP, e ambos chamam `SubmitWagerTransactionUseCase`. O consumidor grava `(consumerName, messageId, payloadHash)` na inbox na mesma transação SQL que serializa a chave, bloqueia a wallet e grava operação, saldo e ledger. `processed_at` também é marcado nessa transação. O ACK via `DeleteMessage` ocorre somente depois do commit. Redelivery do mesmo ID e payload não repete efeitos; o hash divergente é tratado como falha e segue a política de retry/DLQ.

Falhas não confirmadas usam `ChangeMessageVisibility` com atraso exponencial de 1, 2, 4, 8 e até 16 segundos. A política de redrive da fila move mensagens malsucedidas após cinco entregas para `wager-transactions-dlq.fifo`. Rejeições de negócio persistidas (por exemplo, saldo insuficiente ou referência pendente) são resultados terminais do caso de uso e recebem ACK. Mensagens inválidas e erros técnicos não recebem ACK. O worker solicita uma mensagem por vez, mantém o processamento dentro de um contexto MikroORM e, no encerramento do NestJS, aborta o long-poll e aguarda a operação em andamento. O campo opcional `WAGER_TRANSACTIONS_QUEUE_URL` permite configurar uma URL explícita; sem ele, o consumidor resolve o nome da fila.

Os eventos de integração são inseridos na outbox dentro da transação financeira. Publishers concorrentes reservam registros pendentes com lease e `FOR UPDATE SKIP LOCKED`, publicam somente após o commit original e marcam sucesso ou agendam retry com backoff persistente. O lease e a condição de aggregate anterior não publicado evitam publicação concorrente e fora de ordem. Publicação duplicada após falha entre envio e marcação é esperada e deve ser segura para consumidores.

Eventos publicados em `wager-events.fifo`: `WagerTransactionProcessed`, `WagerTransactionRejected`, `WagerTransactionPendingReference`, `WagerTransactionReferenceExpired` e `WalletBalanceChanged` somente quando o saldo muda. `MessageGroupId` usa o aggregate e `MessageDeduplicationId` o ID persistido do evento. O envelope contém `eventId`, `aggregateId`, `eventType`, `occurredAt` e `payload`. Como SQS e PostgreSQL não compartilham uma transação, consumidores deduplicam pelo `eventId`.

## API, autenticação e health checks

Controllers HTTP convertem contratos externos para casos de uso e traduzem erros para respostas estáveis. Payload inválido, conflito de idempotência, rejeição de negócio, processamento pendente e falha transitória devem ser distinguíveis.

A camada de apresentação valida o corpo da operação e o header `Idempotency-Key` antes de chamar o caso de uso. O payload aceita apenas tipos externos, exige UUIDs para wallet e jogador, strings decimais positivas, moeda ISO 4217 e no máximo uma referência para REFUND/ROLLBACK. O filtro global retorna `{ error: { code, message, details? }, correlationId? }`, sem expor mensagens internas ou payloads financeiros. Os contratos usam códigos estáveis: 400 `INVALID_REQUEST`, 404 `NOT_FOUND`, 409 `IDEMPOTENCY_CONFLICT` ou `WALLET_ALREADY_EXISTS`, 422 para rejeições de negócio (como `INSUFFICIENT_BALANCE`), 202 `PROCESSING_PENDING`, 500 `PROCESSING_FAILED` terminal e 503 `SERVICE_UNAVAILABLE` transitório. Testes HTTP validam payload/header inválidos, conflito, rejeição de saldo insuficiente, pendência por referência ausente e replay da resposta pendente.

Autenticação não vale pontos no desafio e é opcional. A decisão atual é não implementá-la nesta etapa. Se continuar fora do escopo, documentar o desenho futuro e deixar um ponto de extensão para identidade de provedor/guard. Não criar autenticação própria com tabela e hash de senha. Health checks ficam abertos; mensagens de fila são canal interno confiável, mas ainda passam pelas validações do domínio.

`/health/live` verifica somente se o processo responde. `/health/ready` verifica PostgreSQL, as filas de transações e eventos e suas respectivas DLQs.

## Migrations e estado atual do banco

Migrations são versionadas, transacionais e reversíveis. O executor atual guarda versões em `schema_migrations` e usa advisory lock PostgreSQL para serializar execuções concorrentes.

A migration `001-initial-structure` cria a estrutura inicial de wallets, transações, ledger, inbox e outbox; `002-ledger-reversals` vincula reversões a lançamentos originais; `003-wallet-version-zero` alinha a versão inicial do banco com o aggregate. Os marcos 10 e 11 usam repositórios na mesma transação para atualizar wallet, transação e ledger atomicamente e assegurar replay idempotente. A inbox é usada pelo consumidor SQS para deduplicação atômica e a outbox do marco 16 publica eventos com leases persistidos sem exigir mudança de schema.

## Observabilidade e testes

Logs HTTP estruturados em JSON incluem `correlationId`, método, rota normalizada, status e duração, sem registrar payloads ou valores financeiros. O cabeçalho `X-Correlation-Id` é validado e propagado na resposta; valores inválidos são substituídos por UUID. Logs de processamento incluem IDs operacionais (transação, wallet, provedor e mensagem quando disponíveis), status e duração, mas não valores, tokens ou payloads financeiros. `GET /metrics` expõe `http_server_requests_total` (contador por método, rota e status), `http_server_request_duration_seconds` (histograma em segundos), `health_dependency_checks_total` (contador por dependência e resultado), `wager_transactions_total` (contador por origem e status), `wager_transaction_duplicates_total` (contador por origem), `wager_retries_total` (contador por origem e resultado), `sqs_dead_letter_queue_messages` (gauge de profundidade aproximada por fila), `database_lock_conflicts_total` (contador por tipo), `wager_transaction_processing_duration_seconds` e `outbox_publish_delay_seconds` (histogramas em segundos). `GET /health/live` verifica somente o processo; `GET /health/ready` verifica PostgreSQL e filas SQS.

As profundidades das duas DLQs são coletadas a cada 15 segundos pelos atributos aproximados do SQS. Conflitos de lock incluem deadlocks, locks indisponíveis e falhas de serialização do PostgreSQL; os logs de publisher e consumidor registram IDs operacionais e resultado do retry, sem conteúdo das mensagens.

Os testes unitários de `Money`, `Wallet`, `WagerTransaction`, `WalletLedgerEntry` e da infraestrutura de métricas/correlação cobrem precisão monetária, invariantes de saldo e versionamento, transições de estado, terminalidade, reidratação, aritmética dos lançamentos, regras de reversão e exposição de métricas. Testes do consumidor validam o contrato da mensagem, ACK somente após o caso de uso concluir, retry sem ACK e encerramento seguro durante o long-poll. Testes do publisher cobrem o envelope FIFO, retry após falha e marcação após aceitação pelo SQS. Testes PostgreSQL validam claims concorrentes disjuntos, ordenação por aggregate, leases/retries, endpoints HTTP, inbox atômica e retries de referência, incluindo resolução após chegada fora de ordem, expiração após cinco tentativas, evento único na outbox e ausência de lançamentos duplicados. Ainda são possíveis duplicatas quando o processo cai após o envio ao broker e antes de marcar a outbox. O invariante final é `wallet.balance == saldo reconstruído pelo ledger`.

## Decisões ainda revisáveis

- Limite de tentativas e TTL para referências pendentes.
- Taxonomia completa de failure codes e mapeamento de status HTTP.
- Política de retry/backoff para consumidores e publishers.
- Integração do versionamento da wallet com a gravação concorrente no PostgreSQL.
- Autenticação externa, caso seja implementada.
