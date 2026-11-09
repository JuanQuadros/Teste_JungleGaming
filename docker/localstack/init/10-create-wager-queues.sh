#!/bin/sh
set -eu

# Create the dead-letter queue first so the source queue can reference its ARN.
dlq_url="$(awslocal sqs create-queue \
  --queue-name wager-transactions-dlq.fifo \
  --attributes FifoQueue=true,ContentBasedDeduplication=false \
  --query QueueUrl --output text)"

dlq_arn="$(awslocal sqs get-queue-attributes \
  --queue-url "$dlq_url" \
  --attribute-names QueueArn \
  --query Attributes.QueueArn --output text)"

# RedrivePolicy is itself a JSON string inside the attributes JSON object.
queue_attributes="$(printf '{"FifoQueue":"true","ContentBasedDeduplication":"false","RedrivePolicy":"{\\"deadLetterTargetArn\\":\\"%s\\",\\"maxReceiveCount\\":\\"5\\"}"}' "$dlq_arn")"
awslocal sqs create-queue \
  --queue-name wager-transactions.fifo \
  --attributes "$queue_attributes"
