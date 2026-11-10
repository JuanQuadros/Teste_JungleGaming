export const name = '009-versioned-outbox-events';

export const up = [
  `alter table outbox_messages
    add column correlation_id text not null default gen_random_uuid()::text,
    add column causation_id text,
    add column event_version integer not null default 1
      check (event_version > 0)`,
];

export const down = [
  `alter table outbox_messages
    drop column event_version,
    drop column causation_id,
    drop column correlation_id`,
];
