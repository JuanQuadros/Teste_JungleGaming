#!/bin/sh
set -eu

# Cria primeiro a fila de mensagens não processadas (DLQ) para que a fila principal possa referenciá-la.
dlq_url="$(awslocal sqs create-queue \
  --queue-name wager-transactions-dlq.fifo \
  --attributes FifoQueue=true,ContentBasedDeduplication=false \
  --query QueueUrl --output text)"

# Obtém o ARN da fila de mensagens não processadas (DLQ) para que possamos referenciá-lo na política de redirecionamento da fila principal.
dlq_arn="$(awslocal sqs get-queue-attributes \
  --queue-url "$dlq_url" \
  --attribute-names QueueArn \
  --query Attributes.QueueArn --output text)"

# A política de redirecionamento também é uma string JSON dentro do objeto de atributos.
queue_attributes="$(printf '{"FifoQueue":"true","ContentBasedDeduplication":"false","RedrivePolicy":"{\\"deadLetterTargetArn\\":\\"%s\\",\\"maxReceiveCount\\":\\"5\\"}"}' "$dlq_arn")"
awslocal sqs create-queue \
  --queue-name wager-transactions.fifo \
  --attributes "$queue_attributes"
