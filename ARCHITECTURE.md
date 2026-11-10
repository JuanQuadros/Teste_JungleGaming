# Arquitetura — Jungle Gaming

## Estado e escopo

Este documento registra as decisões que devem orientar a implementação do desafio. A infraestrutura está preparada e os componentes de domínio `Money`, `Wallet` e `WagerTransaction` já foram implementados. Os casos de uso financeiros e os workers ainda não foram implementados.

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
2. **Aplicação:** casos de uso que coordenam validação, transação financeira, idempotência, publicação de eventos e consultas.
3. **Infraestrutura:** repositórios MikroORM, transações PostgreSQL, clientes e workers SQS, inbox/outbox e observabilidade.
4. **Apresentação:** controllers HTTP, DTOs, validação de entrada e mapeamento consistente de respostas e erros.

O domínio não deve conhecer detalhes de transporte ou persistência. A aplicação coordena portas; a infraestrutura implementa essas portas.

## Representação monetária

Valores entram e saem da API como strings decimais, por exemplo `"25.00"`. O `Money` implementado armazena centavos em `BigInt`, sem converter dinheiro para `number` ou ponto flutuante, e serializa sempre com duas casas. Sua faixa respeita `numeric(20, 2)`, que é o tipo usado no schema inicial do PostgreSQL; o banco nunca usa `real` ou `double precision` para valores monetários.

`Money` é imutável, valida escala e código de moeda e rejeita valores negativos nos contratos de criação. Operações do domínio, como `negate` e `subtract`, podem produzir negativos sem alterar a instância original. A moeda permanece parte do modelo para validar incompatibilidades, mesmo que o escopo inicial use somente BRL.

`Wallet` é o aggregate que associa identificador e jogador a uma moeda, saldo e versão. A abertura começa com saldo zero e versão zero; crédito e débito aceitam somente valores positivos da mesma moeda e avançam a versão uma vez por alteração aceita. Débito acima do saldo é rejeitado sem alterar estado. A versão é um inteiro seguro não negativo, restaurado junto com os demais dados persistidos; o mecanismo concorrente entre instâncias continuará sendo responsabilidade da transação PostgreSQL.

## Transação financeira e concorrência

O PostgreSQL é a autoridade final para concorrência e invariantes. A unidade de serialização é `walletId`; não haverá lock global.

**Estratégia proposta:** dentro de uma transação SQL, bloquear a linha da wallet com lock pessimista (`SELECT ... FOR UPDATE`), validar o saldo e referências, gravar a transação e o ledger, atualizar o saldo/versionamento e inserir os eventos na outbox. A transação inteira confirma ou reverte em conjunto. Isso serializa operações concorrentes da mesma wallet e permite que wallets diferentes avancem em paralelo em múltiplas instâncias.

Constraints no banco complementam as validações do domínio: unicidade de wallet por jogador/moeda, idempotência e identidade externa, saldo não negativo, no máximo um lançamento por transação, no máximo uma reversão por lançamento original e imutabilidade do ledger. `WalletLedgerEntry` valida direção, valor e saldos anterior/posterior. BET gera débito; WIN e OPENING processados geram crédito; LOSS e transações não processadas não geram lançamento. REFUND só reverte BET processada; ROLLBACK pode reverter uma operação processada com lançamento original, exceto REFUND e ROLLBACK. Ambos exigem valor integral e referência do mesmo provedor, jogador, wallet, moeda e rodada. A reversão cria um novo lançamento oposto, sem alterar o original. A consistência entre o saldo materializado e a soma do ledger deve ser mantida por cada caso de uso transacional e conferida por reconciliação.

## Idempotência e identidade de transação

O header `Idempotency-Key` é a fonte da verdade e deve ter unicidade persistente no banco. O hash será SHA-256 de uma representação JSON canônica dos campos de negócio, com chaves ordenadas; metadados de transporte não participam do hash.

- Mesma chave e mesmo hash: retornar a resposta original como replay.
- Mesma chave e hash diferente: responder conflito, sem alterar saldo.
- Identidade externa: unicidade por `(providerId, externalTransactionId)`.

Chaves em memória e deduplicação do broker são apenas otimizações, nunca garantias.

## Referências e transições fora de ordem

BET, WIN, LOSS, REFUND e ROLLBACK serão tratados por um caso de uso compartilhado pela entrada HTTP e pelo consumidor SQS. REFUND e ROLLBACK exigem referência válida do mesmo provedor, jogador, wallet, moeda e rodada. Referência ainda ausente produz `PENDING_REFERENCE`, sem movimento de saldo, para reprocessamento com backoff e limite documentado.

`WagerTransaction` começa em `PENDING` e pode aguardar referência, voltar ao processamento ou encerrar como `PROCESSED`, `REJECTED` ou `FAILED`. Estados terminais não aceitam novas transições. A reidratação valida e restaura o estado persistido diretamente, sem repetir o histórico de transições. Rejeições possuem códigos estáveis para saldo insuficiente, referência inválida e reversão que causaria saldo negativo; falhas técnicas usam `PROCESSING_FAILED`. `OPENING` existe no modelo persistido, mas a factory de entrada externa exclui esse tipo: sua criação fica reservada ao código interno. As interfaces HTTP e SQS ainda deverão respeitar essa separação.

Reversões não podem acontecer mais de uma vez nem tornar o saldo negativo.

## SQS, inbox e outbox

O consumidor grava `(consumerName, messageId)` na inbox na mesma transação SQL que processa a operação. O ack ocorre somente depois do commit. Redelivery não repete efeitos; erros de negócio são terminais, falhas transitórias são tentadas novamente e falhas permanentes/limite excedido seguem para a DLQ.

Os eventos de integração são inseridos na outbox dentro da transação financeira. Publishers concorrentes reservam registros pendentes no banco, publicam somente após o commit original e marcam sucesso ou agendam retry com backoff. Publicação duplicada é esperada e deve ser segura para consumidores.

Eventos mínimos: `WagerTransactionProcessed`, `WagerTransactionRejected`, `WagerTransactionPendingReference` e `WalletBalanceChanged` somente quando o saldo muda.

## API, autenticação e health checks

Controllers HTTP convertem contratos externos para casos de uso e traduzem erros para respostas estáveis. Payload inválido, conflito de idempotência, rejeição de negócio, processamento pendente e falha transitória devem ser distinguíveis.

Autenticação não vale pontos no desafio e é opcional. A decisão atual é não implementá-la nesta etapa. Se continuar fora do escopo, documentar o desenho futuro e deixar um ponto de extensão para identidade de provedor/guard. Não criar autenticação própria com tabela e hash de senha. Health checks ficam abertos; mensagens de fila são canal interno confiável, mas ainda passam pelas validações do domínio.

`/health/live` verifica somente se o processo responde. `/health/ready` verifica PostgreSQL e as filas SQS necessárias.

## Migrations e estado atual do banco

Migrations são versionadas, transacionais e reversíveis. O executor atual guarda versões em `schema_migrations` e usa advisory lock PostgreSQL para serializar execuções concorrentes.

A migration `001-initial-structure` cria a estrutura inicial de wallets, transações, ledger, inbox e outbox, incluindo constraints estruturais. Ela não implementa os casos de uso financeiros nem substitui futuras entidades, repositórios ou regras do domínio.

## Observabilidade e testes

Logs HTTP estruturados em JSON incluem `correlationId`, método, rota normalizada, status e duração, sem registrar payloads ou valores financeiros. O cabeçalho `X-Correlation-Id` é validado e propagado na resposta; valores inválidos são substituídos por UUID. `GET /metrics` expõe métricas Prometheus: `http_server_requests_total` (contador por método, rota e status), `http_server_request_duration_seconds` (histograma em segundos) e `health_dependency_checks_total` (contador por dependência e resultado). Métricas de transações por status, duplicatas, retries, mensagens na DLQ, conflitos de lock e atraso da outbox ainda dependem da implementação dos respectivos fluxos e devem ser instrumentadas neles.

Os testes unitários de `Money`, `Wallet`, `WagerTransaction`, `WalletLedgerEntry` e da infraestrutura de métricas/correlação cobrem precisão monetária, invariantes de saldo e versionamento, transições de estado, terminalidade, reidratação, aritmética dos lançamentos, regras de reversão e exposição de métricas. Ainda serão necessários testes de integração real com PostgreSQL e LocalStack, paralelismo, redelivery, falhas após commit, publishers concorrentes e reinicialização. O invariante final é `wallet.balance == saldo reconstruído pelo ledger`.

## Decisões ainda revisáveis

- Limite de tentativas e TTL para referências pendentes.
- Taxonomia completa de failure codes e mapeamento de status HTTP.
- Política de retry/backoff para consumidores e publishers.
- Integração do versionamento da wallet com a gravação concorrente no PostgreSQL.
- Autenticação externa, caso seja implementada.
