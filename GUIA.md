# Guia de apresentação — Processador de apostas

## Em uma frase

Este serviço processa transações financeiras de apostas e mantém saldo, histórico e eventos consistentes mesmo quando há reenvios, falhas ou várias instâncias concorrentes.

## Como funciona

1. A API recebe uma operação ou um worker recebe uma mensagem SQS.
2. O domínio valida valor, moeda, estado da transação e regras de negócio. Dinheiro é representado por centavos `BigInt`; a API recebe valores decimais em strings.
3. O PostgreSQL serializa a mesma chave idempotente e bloqueia a linha da wallet. Saldo, transação, ledger e evento de outbox são gravados na mesma transação SQL.
4. Se a operação veio do SQS, a inbox também é gravada no mesmo commit. O consumidor só confirma a mensagem depois do commit.
5. Um publisher separado envia os eventos pendentes da outbox ao SQS. Como banco e fila não compartilham uma transação, a entrega é at-least-once e o consumidor downstream deve deduplicar pelo `eventId`.
6. A reconciliação compara o saldo da wallet à soma do ledger e informa divergências sem corrigi-las automaticamente.

## Garantias implementadas e evidências

- **Precisão monetária:** `Money` usa centavos `BigInt`; o PostgreSQL persiste `NUMERIC(20,2)`. Testes unitários verificam formato, precisão e moedas incompatíveis.
- **Invariantes no banco:** saldo não negativo, wallet única por jogador/moeda, identidade de transação/idempotência, lançamentos únicos e ledger imutável (incluindo bloqueio a `TRUNCATE`) têm constraints ou trigger. Wallets começam na versão 1; trigger diferido mantém saldo e soma do ledger alinhados em novos commits.
- **Idempotência persistente:** chave e hash do payload ficam no PostgreSQL; repetição igual não repete o efeito, e a mesma chave com payload diferente é conflito.
- **Concorrência:** lock PostgreSQL por chave e por wallet evita disputa local à instância. Testes reais cobrem 50 reenvios e duas apostas de R$ 80,00 contra saldo de R$ 100,00.
- **Inbox/outbox:** gravações são atômicas ao commit financeiro; testes reais cobrem retry, DLQ, crash depois do commit antes do ACK e publishers concorrentes.
- **Ledger e recuperação:** REFUND/ROLLBACK fora de ordem são reprocessados; teste reconecta o ORM e reconcilia saldo e lançamentos.

Na validação registrada para esta entrega, passaram **38 testes e2e em 10 arquivos**, **90 testes unitários em 14 arquivos**, lint e build. O teste de múltiplas instâncias usa três consumers/EntityManagers independentes no mesmo processo; não é uma orquestração de três processos NestJS distintos. São resultados observados nesta revisão; não são garantia de desempenho ou operação em produção.

## O que não está garantido ou não foi implementado

- Autenticação de provedores não foi implementada. O desafio permite deixar esse item de fora; para produção, integrar um provedor de identidade externo e proteger a API.
- O envelope atual da outbox tem `eventId`, `aggregateId`, `eventType`, `occurredAt` e `payload`, mas não campos explícitos de versão, correlação ou causação nem classes de evento tipadas. Esse contrato precisa ser versionado antes de integração com consumidores externos.
- Publicação não é exactly-once. Uma queda entre envio ao SQS e marcação no PostgreSQL pode gerar duplicata; consumidores devem deduplicar por `eventId`.
- A migration de consistência não corrige divergências anteriores. Reconcilie explicitamente dados legados antes de operar wallets inconsistentes; os testes e2e usam schemas isolados e deixam os dados persistentes fora do escopo.
- A configuração local dos testes depende de Docker, PostgreSQL, LocalStack e de um token válido para a imagem LocalStack definida no Compose.

## Preparar uma demonstração

Na raiz do projeto, configure `docker/.env` e `backend/.env` usando os arquivos `.env.example`, preencha o token local exigido pelo LocalStack e inicie os serviços:

```powershell
Copy-Item docker\.env.example docker\.env
Copy-Item backend\.env.example backend\.env
docker compose --env-file docker/.env -f docker/compose.yaml up -d
docker compose --env-file docker/.env -f docker/compose.yaml ps
```

Na pasta `backend/`:

```powershell
bun install
bun run db:migrate
bun run test
bun run test:e2e
bun run lint
bun run build
bun run start:dev
```

Em outro terminal, verifique `http://localhost:3000/health/live`,
`http://localhost:3000/health/ready` e `http://localhost:3000/metrics`.
`/live` verifica o processo; `/ready` verifica PostgreSQL e filas SQS.

## Roteiro curto para apresentação

> O desafio é manter a correção financeira com entrega at-least-once e várias instâncias. Por isso, não trato memória nem FIFO como fonte de verdade. `Money` evita ponto flutuante, e o PostgreSQL é responsável por idempotência, locks e constraints. Saldo, transação, ledger e outbox são confirmados no mesmo commit; o consumer da inbox só dá ACK depois desse commit. A outbox é publicada separadamente e pode duplicar em uma janela de falha, então consumidores devem deduplicar pelo ID do evento. Os testes usam PostgreSQL e LocalStack reais e exercitam races, redelivery e recuperação. A autenticação e um envelope de evento versionado continuam fora do escopo atual e estão documentados como limitações.

## Termos

- **Idempotência:** repetir a mesma solicitação não repete o efeito financeiro.
- **Ledger:** histórico imutável de créditos e débitos.
- **Inbox:** registro persistente de mensagens recebidas para deduplicar redelivery.
- **Outbox:** eventos gravados no banco junto com a movimentação e enviados depois do commit.
- **DLQ:** fila de destino para mensagens que excederam o limite de tentativas.
- **Reconciliação:** comparação do saldo materializado com o saldo reconstruído do ledger.
