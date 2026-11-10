# Arquitetura — Jungle Gaming

## 1. Objetivo e escopo

Este documento descreve a arquitetura, as decisões técnicas e as garantias implementadas no processador distribuído de apostas da Jungle Gaming.

O sistema recebe transações financeiras de múltiplos provedores por API HTTP ou SQS. Seu objetivo é preservar a consistência de saldo e histórico financeiro diante de reenvios, falhas, concorrência e processamento assíncrono.

O PostgreSQL é a fonte de verdade para as informações financeiras e para os mecanismos persistentes de idempotência, inbox e outbox.

A API HTTP e o consumidor SQS compartilham os mesmos casos de uso financeiros.

## 2. Stack tecnológica

- Bun 1.x: runtime, gerenciador de pacotes e executor de testes.
- TypeScript strict: tipagem estática.
- NestJS: framework da aplicação.
- PostgreSQL: persistência e controle transacional.
- MikroORM: mapeamento objeto-relacional.
- AWS SQS: mensageria.
- LocalStack: execução local dos serviços AWS.
- Docker Compose: infraestrutura de desenvolvimento.
- Vitest: testes unitários e E2E.

## 3. Arquitetura em camadas

As dependências apontam para dentro, em direção ao domínio.

### 3.1 Domain

Contém as regras de negócio independentes de framework e infraestrutura.

Principais componentes:

- `Money`: representação monetária em centavos usando `BigInt`.
- `Wallet`: aggregate responsável pelo saldo, moeda e versão.
- `WagerTransaction`: representa uma operação financeira e seu ciclo de vida.
- `WalletLedgerEntry`: representa um lançamento imutável de crédito ou débito.

O domínio não deve depender de NestJS, MikroORM, PostgreSQL ou SQS.

### 3.2 Application

Coordena os casos de uso e define as portas necessárias para persistência e integração.

Responsabilidades:

- Processar transações de apostas.
- Criar wallets.
- Aplicar regras de idempotência.
- Coordenar transações financeiras.
- Construir eventos de integração.
- Solicitar persistência por meio das portas e unidades de trabalho.

Principais casos de uso:

- `ProcessWagerTransactionUseCase`
- `CreateWalletUseCase`

O envelope de integração e suas classes concretas também pertencem à camada de aplicação.

### 3.3 Infrastructure

Implementa os detalhes técnicos:

- Entidades e repositórios MikroORM.
- Unidades de trabalho transacionais.
- Migrations PostgreSQL.
- Persistência de inbox e outbox.
- Consumidor SQS.
- Publisher de eventos.
- Workers de retry e recuperação.

A infraestrutura implementa as portas definidas pela aplicação.

### 3.4 Presentation

Responsável pelos contratos externos:

- Controllers HTTP.
- DTOs.
- Pipes e validação.
- Mapeamento de respostas.
- Tratamento de erros.
- Middleware de observabilidade e correlation ID.

Entidades MikroORM não são expostas diretamente pela API.

## 4. Fluxo geral de processamento

Uma operação pode chegar por dois caminhos:

1. API HTTP.
2. Mensagem na fila SQS `wager-transactions.fifo`.

Ambos utilizam o mesmo caso de uso financeiro.

Fluxo simplificado:

1. A entrada é validada.
2. O caso de uso verifica a chave idempotente.
3. A unidade de trabalho inicia uma transação SQL.
4. O PostgreSQL serializa a chave idempotente e bloqueia a wallet quando necessário.
5. O domínio valida a operação e calcula os efeitos financeiros.
6. Wallet, transação, ledger e eventos da outbox são persistidos no mesmo commit.
7. Para mensagens SQS, o registro da inbox também é confirmado nesse commit.
8. Após o commit, o consumidor confirma a mensagem recebida.
9. O publisher processa separadamente os eventos pendentes da outbox.

Essa separação evita que a memória de uma instância ou a deduplicação temporária do broker sejam tratadas como fonte de verdade.

## 5. Representação monetária

Valores monetários entram e saem da API como strings decimais, por exemplo:

```json
{
  "amount": "25.00",
  "currency": "BRL"
}
```

O objeto de valor `Money` armazena centavos usando `BigInt`, evitando erros de ponto flutuante.

O PostgreSQL utiliza `NUMERIC(20,2)` para persistência monetária.

Princípios:

- Não converter valores financeiros para `number` para realizar cálculos.
- Preservar duas casas decimais na serialização.
- Validar escala e moeda.
- Rejeitar valores inválidos nos contratos de entrada.
- Evitar alterações na instância original durante operações aritméticas.

A moeda faz parte do modelo e é validada nas operações financeiras.

## 6. Wallet e versionamento

`Wallet` é o aggregate que associa jogador, identificador, moeda, saldo e versão.

Regras implementadas:

- Wallets começam na versão 1.
- Saldo não pode ficar negativo.
- Débitos e créditos aceitos atualizam a versão.
- Uma wallet por combinação de jogador e moeda.
- Operações financeiras preservam a moeda da wallet.

Quando `initialBalance` é positivo, a criação da wallet, a transação interna `OPENING` e o lançamento de crédito são persistidos na mesma transação SQL.

A operação `OPENING` é interna e não pode ser submetida por provedores externos.

## 7. Transação financeira e concorrência

O PostgreSQL é a autoridade final para concorrência e invariantes.

A unidade de serialização financeira é a wallet, não um lock global.

A unidade de trabalho transacional:

1. Abre uma transação SQL.
2. Obtém advisory lock para a chave idempotente.
3. Consulta a operação persistida.
4. Para uma operação nova, bloqueia a wallet com lock pessimista (`SELECT ... FOR UPDATE`).
5. Executa o caso de uso e agenda as alterações.
6. Persiste os registros financeiros e os eventos da outbox.
7. Confirma ou reverte a transação.

Chaves e wallets diferentes podem avançar em paralelo.

Erros técnicos provocam rollback. Rejeições de negócio e pendências podem ser persistidas como resultados da operação sem movimentar o saldo.

## 8. Idempotência

A API exige o header `Idempotency-Key`.

A chave e o hash do payload são persistidos no PostgreSQL.

O hash SHA-256 é calculado sobre os campos de negócio, em ordem definida, sem incluir metadados de transporte ou o próprio hash.

Comportamento:

- Mesma chave e mesmo hash: retorna a operação persistida sem repetir os efeitos financeiros.
- Mesma chave e hash diferente: retorna conflito de idempotência.
- Identidade externa: unicidade por `(providerId, externalTransactionId)`.

O saldo observado na resposta original também é persistido em `response_balance`. Assim, um replay pode retornar o resultado original mesmo que a wallet tenha recebido outras operações posteriormente.

A resposta de submissão informa `idempotentReplay`:

- `false`: operação processada originalmente.
- `true`: operação anteriormente persistida foi retornada.

A idempotência não depende apenas de memória, cache ou deduplicação do broker.

## 9. Ledger e invariantes financeiras

`WalletLedgerEntry` registra os movimentos financeiros de crédito e débito.

O histórico é imutável. Os lançamentos não são atualizados ou removidos para corrigir operações anteriores.

O banco protege, entre outras regras:

- Saldo não negativo.
- Unicidade de wallet por jogador/moeda.
- Identidade e idempotência de transações.
- No máximo um lançamento por transação.
- No máximo uma reversão por transação original.
- Imutabilidade do ledger, incluindo proteção contra `TRUNCATE`.
- Consistência entre saldo materializado e soma do ledger.

A migration 007 instala constraint triggers diferidos até o commit para verificar a consistência entre wallet e ledger.

Esses triggers protegem alterações futuras, mas não corrigem automaticamente divergências anteriores.

### 9.1 Tipos de operação

- `BET`: gera débito quando processada.
- `WIN`: gera crédito quando processada.
- `LOSS`: não gera movimentação de saldo.
- `REFUND`: reverte uma BET processada.
- `ROLLBACK`: reverte uma operação processada elegível que possua lançamento original.
- `OPENING`: operação interna de crédito inicial da wallet.

### 9.2 REFUND e ROLLBACK

As reversões validam a referência original, o tipo de operação, o valor integral e a identidade de provedor, jogador, wallet, moeda e rodada.

Cada reversão cria um novo lançamento de direção oposta, vinculado ao lançamento original.

O lançamento anterior não é alterado.

O `ROLLBACK` pode reverter um `REFUND`, desde que a operação original e o lançamento sejam elegíveis. Não pode reverter outro `ROLLBACK`.

Constraints no PostgreSQL impedem a duplicidade de reversões.

Os testes E2E também verificam os lançamentos persistidos e a reconciliação depois de REFUND e ROLLBACK, inclusive quando a referência chega fora de ordem.

## 10. Referências fora de ordem e retries

REFUND e ROLLBACK dependem de uma referência financeira válida.

Se a referência ainda não existir, a transação fica em `PENDING_REFERENCE`, sem movimentação de saldo.

O worker `PendingReferenceRetryWorker` consulta pendências periodicamente.

Configuração documentada:

- Verificação a cada segundo.
- Lotes de até 50 itens.
- Primeira tentativa agendada para um segundo após a submissão.
- Até cinco retries, com intervalos exponenciais de 2, 4, 8 e 16 segundos.

Os dados de retry são persistidos no PostgreSQL, permitindo continuidade após reinícios.

Quando a referência aparece, o mesmo caso de uso valida os dados e aplica a reversão.

Se a referência não chegar após as tentativas previstas, a operação termina com `REFERENCE_NOT_FOUND`, sem movimentação financeira, e o evento `WagerTransactionReferenceExpired` é gravado na outbox no mesmo commit.

## 11. Inbox e consumidor SQS

O consumidor recebe mensagens da fila FIFO `wager-transactions.fifo`.

O corpo contém:

- `idempotencyKey`
- `transaction`

A mensagem passa pela mesma validação e pelo mesmo caso de uso da API HTTP.

A inbox persiste a identidade da mensagem e seu hash de payload.

O registro da inbox e os efeitos financeiros são confirmados na mesma transação PostgreSQL.

O consumidor executa `DeleteMessage` somente após o commit.

Consequências:

- Redelivery da mesma mensagem não repete efeitos.
- Falhas antes do commit não devem confirmar a mensagem.
- Falhas técnicas seguem a política de retry.
- Rejeições de negócio persistidas são resultados terminais e podem receber ACK.

Falhas não confirmadas utilizam `ChangeMessageVisibility` com atrasos exponenciais.

Após cinco entregas malsucedidas, a política de redrive encaminha a mensagem para `wager-transactions-dlq.fifo`.

O encerramento do worker cancela o long-poll e aguarda o processamento em andamento.

## 12. Outbox e publicação de eventos

Os eventos são persistidos na outbox dentro da transação financeira.

Isso garante que uma movimentação financeira confirmada e seu evento correspondente sejam gravados atomicamente no PostgreSQL.

A publicação acontece depois do commit original.

Publishers concorrentes utilizam leases persistidos e `FOR UPDATE SKIP LOCKED` para reservar eventos sem reivindicar simultaneamente o mesmo registro.

A implementação também preserva a ordem de publicação por aggregate, considerando os eventos anteriores ainda não publicados.

Falhas são reagendadas com backoff persistente.

Uma queda depois do envio ao SQS e antes da marcação no PostgreSQL pode causar publicação duplicada. Por isso, a garantia é at-least-once, não exactly-once.

Consumidores devem deduplicar pelo `eventId`.

## 13. Contrato IntegrationEvent

Os eventos utilizam um envelope de integração versionado.

Campos:

| Campo | Finalidade |
|---|---|
| `eventId` | Identificador único do evento |
| `eventType` | Tipo concreto do evento |
| `aggregateId` | Identificador do aggregate relacionado |
| `correlationId` | Identificador para rastrear a operação |
| `causationId` | Identificador da causa imediata, quando disponível |
| `occurredAt` | Data e hora da ocorrência |
| `version` | Versão do contrato |
| `data` | Dados específicos do evento |

A implementação contém uma classe base `IntegrationEvent` e classes concretas:

- `WagerTransactionProcessed`
- `WagerTransactionRejected`
- `WagerTransactionPendingReference`
- `WagerTransactionReferenceExpired`
- `WalletBalanceChanged`

A factory `createIntegrationEvent` centraliza a criação dos eventos de transação.

`WalletBalanceChanged.from(...)` constrói o evento de alteração de saldo a partir da wallet e do lançamento financeiro, validando a relação entre wallet, moeda e saldo.

O evento de alteração de saldo é criado quando há movimentação financeira correspondente.

O envelope também mantém aliases de compatibilidade com o contrato interno da outbox (`id` e `payload`), sem alterar os nomes do contrato de integração.

A migration 009 persiste os dados de versão, correlação e causação necessários à publicação.

O publisher reconstrói o envelope completo a partir dos dados persistidos e publica em `wager-events.fifo`.

Configuração FIFO:

- `MessageGroupId`: aggregate.
- `MessageDeduplicationId`: identificador persistido do evento.

O SQS não substitui a deduplicação persistente dos consumidores.

## 14. API HTTP

Endpoints implementados:

| Método | Endpoint | Descrição |
|---|---|---|
| POST | `/wallets` | Criação de wallet |
| GET | `/wallets/:walletId` | Consulta de wallet |
| GET | `/wallets/:walletId/ledger` | Histórico financeiro |
| POST | `/wallets/:walletId/reconciliation` | Reconciliação |
| POST | `/wagering/transactions` | Submissão de transação |
| GET | `/wagering/transactions/:transactionId` | Consulta por ID interno |
| GET | `/wagering/transactions/by-external` | Consulta por identidade externa |

O histórico do ledger utiliza ordenação estável por timestamp e UUID, com cursor opaco Base64URL e limite configurável entre 1 e 100.

### 14.1 Respostas e erros

O filtro global padroniza erros no formato:

```json
{
  "error": {
    "code": "ERROR_CODE",
    "message": "Descrição do erro"
  },
  "correlationId": "uuid"
}
```

Os contratos distinguem erros de validação, não encontrado, conflito de idempotência, rejeição de negócio, processamento pendente e falha transitória.

Códigos documentados:

- 400: `INVALID_REQUEST`
- 404: `NOT_FOUND`
- 409: `IDEMPOTENCY_CONFLICT` ou `WALLET_ALREADY_EXISTS`
- 422: rejeições de negócio, como `INSUFFICIENT_BALANCE`
- 202: `PROCESSING_PENDING`
- 500: `PROCESSING_FAILED`
- 503: `SERVICE_UNAVAILABLE`

A API não implementa autenticação de provedores nesta etapa. Um guard ou middleware integrado a um provedor de identidade externo é um possível ponto de extensão.

## 15. Reconciliação

O endpoint `POST /wallets/:walletId/reconciliation` compara o saldo materializado da wallet com o saldo reconstruído a partir do ledger.

A soma utiliza aritmética exata, sem ponto flutuante.

A resposta informa:

- Saldo da wallet.
- Saldo calculado pelo ledger.
- Diferença.
- Indicador de consistência.
- Quantidade de lançamentos verificados.

Divergências são registradas em logs estruturados e na métrica `wallet_reconciliations_total`.

A reconciliação é somente de leitura. Não altera automaticamente wallet ou ledger.

## 16. Observabilidade

O middleware HTTP:

- Valida `X-Correlation-Id`.
- Gera UUID quando o valor é inválido ou inexistente.
- Propaga o identificador na resposta.
- Mantém o contexto durante a execução por meio de `AsyncLocalStorage`.

Logs estruturados registram informações operacionais sem expor payloads ou valores financeiros.

A aplicação disponibiliza:

- `GET /health/live`
- `GET /health/ready`
- `GET /metrics`

Métricas incluem requisições HTTP, latência, verificações de dependências, processamento de transações, duplicatas, retries, conflitos de locks, profundidade aproximada de DLQs, atraso de publicação e reconciliação.

`/health/live` verifica somente o processo.

`/health/ready` verifica PostgreSQL, filas de transações, filas de eventos e respectivas DLQs.

## 17. Migrations

As migrations são versionadas e executadas por um executor que utiliza transação PostgreSQL e advisory lock.

A evolução do schema inclui:

- `001`: estrutura inicial de wallets, transações, ledger, inbox e outbox.
- `002`: vínculo e proteção de reversões no ledger.
- `003`: compatibilidade histórica de versão zero da wallet.
- `004`: persistência do saldo original da resposta.
- `005`: persistência do agendamento de retries de referências.
- `006`: versão inicial da wallet igual a 1.
- `007`: consistência diferida entre saldo e ledger.
- `008`: proteção adicional de imutabilidade do ledger, incluindo `TRUNCATE`.
- `009`: persistência de versão, correlação e causação dos eventos de integração.
- `010`: timestamps terminais de transações, com backfill e constraints correspondentes.

O executor controla as migrations aplicadas em `schema_migrations`.

As migrations não devem ser alteradas retroativamente depois de aplicadas em ambientes persistentes. Mudanças de schema devem ser feitas por novas migrations.

## 18. Estratégia de testes

A implementação possui testes unitários e E2E.

Os testes unitários cobrem regras de domínio, objetos de valor, eventos, validações e componentes de infraestrutura.

Os testes E2E utilizam PostgreSQL e LocalStack reais em containers.

A cobertura inclui:

- Precisão monetária.
- Invariantes de wallet e ledger.
- Idempotência sequencial e concorrente.
- Concorrência de operações financeiras.
- Persistência e reidratação.
- Atomicidade da inbox.
- Publicação e recuperação da outbox.
- Retry e DLQ.
- Referências antecipadas.
- REFUND e ROLLBACK.
- Reversão de REFUND por ROLLBACK.
- Reconciliação após reversões.
- Contratos HTTP.
- Health checks e observabilidade.

### 18.1 Evidência de validação

Na execução mais recente informada durante o desenvolvimento:

| Verificação | Resultado |
|---|---:|
| Build | Aprovado |
| Testes unitários | 124/124 |
| Arquivos unitários | 15/15 |
| Testes E2E | 39/39 |
| Arquivos E2E | 10/10 |
| Total | 163/163 |

Os cenários de concorrência incluem 50 reenvios da mesma aposta, duas apostas de 80,00 contra saldo de 100,00, três consumers independentes no mesmo processo de teste, recuperação após commit antes do ACK e dois publishers concorrentes.

O teste com três consumers não representa três processos NestJS separados implantados em máquinas ou containers independentes.

As contagens são evidências de uma execução específica, não garantias de disponibilidade, desempenho ou comportamento em produção.

## 19. Limitações e decisões

- Autenticação de provedores não foi implementada.
- A publicação PostgreSQL/SQS é at-least-once.
- Consumidores externos devem deduplicar eventos por `eventId`.
- A reconciliação não corrige automaticamente divergências.
- A migration de consistência não corrige dados legados inconsistentes.
- Os testes E2E dependem de PostgreSQL, Docker e LocalStack.
- A topologia real de múltiplos processos NestJS não foi validada pelo teste de múltiplos consumers no mesmo processo.

## 20. Princípio central

A garantia financeira não depende da memória de uma instância, de uma fila ou de uma resposta HTTP.

O PostgreSQL coordena a idempotência, os locks, as transações e as constraints. O ledger mantém o histórico dos movimentos. A inbox protege a entrada assíncrona. A outbox permite publicar eventos depois do commit. O envelope versionado fornece identidade, correlação e causação para integração com outros serviços.

O princípio central é preservar a consistência financeira mesmo diante de reenvios, concorrência e falhas, reconhecendo explicitamente os limites da entrega at-least-once.