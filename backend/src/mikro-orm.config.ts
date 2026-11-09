import { defineConfig } from '@mikro-orm/postgresql';

// Interrompe a inicialização com uma mensagem clara se faltar uma variável obrigatória.
const required = (name: string): string => {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
};

export const mikroOrmConfig = defineConfig({
  // A API roda na máquina local e acessa a porta do Compose por meio de localhost.
  host: required('DB_HOST'),
  port: Number(process.env.DB_PORT ?? 5432),
  dbName: required('POSTGRES_DB'),
  user: required('POSTGRES_USER'),
  password: required('POSTGRES_PASSWORD'),
  entities: [],
  // Até a criação das entidades de domínio, o schema é gerenciado pelo executor explícito de migrations.
  discovery: { warnWhenNoEntities: false },
});
