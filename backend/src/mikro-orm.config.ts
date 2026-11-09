import { defineConfig } from '@mikro-orm/postgresql';

// Fail early with a clear message instead of silently using an incomplete DB config.
const required = (name: string): string => {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
};

export const mikroOrmConfig = defineConfig({
  // The API runs on the host, so it connects through localhost to the published Compose port.
  host: required('DB_HOST'),
  port: Number(process.env.DB_PORT ?? 5432),
  dbName: required('POSTGRES_DB'),
  user: required('POSTGRES_USER'),
  password: required('POSTGRES_PASSWORD'),
  entities: [],
  // The schema is managed by the explicit migration runner until domain entities are introduced.
  discovery: { warnWhenNoEntities: false },
});
