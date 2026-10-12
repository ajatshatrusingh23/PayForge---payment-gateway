/**
 * Centralised configuration. Every value has a sensible local-development
 * default so `npm run dev` works without an .env file; Docker / CI override
 * them through environment variables.
 */
function env(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (value === undefined) {
    throw new Error(`Missing required environment variable ${name}`);
  }
  return value;
}

const int = (name: string, fallback: number) => parseInt(env(name, String(fallback)), 10);
const bool = (name: string, fallback: boolean) => env(name, String(fallback)) === 'true';

export const DEV_INTERNAL_TOKEN = 'pf_internal_dev_token_change_me';
export const DEV_JWT_SECRET = 'pf_dev_jwt_secret_change_me';

export const config = {
  env: env('NODE_ENV', 'development'),
  isProduction: env('NODE_ENV', 'development') === 'production',
  logJson: bool('LOG_JSON', false),
  demoMode: bool('DEMO_MODE', true),

  /** Shared secret proving a request came from inside the platform (gateway or a peer service). */
  internalToken: env('INTERNAL_TOKEN', DEV_INTERNAL_TOKEN),
  jwtSecret: env('JWT_SECRET', DEV_JWT_SECRET),

  db: {
    host: env('DATABASE_HOST', 'localhost'),
    port: int('DATABASE_PORT', 55432),
    user: env('DATABASE_USER', 'payforge'),
    password: env('DATABASE_PASSWORD', 'payforge'),
    poolMax: int('DB_POOL_MAX', 20),
    connectTimeoutMs: int('DB_CONNECT_TIMEOUT_MS', 5000),
  },
  redisUrl: env('REDIS_URL', 'redis://localhost:6379'),
  kafkaBrokers: env('KAFKA_BROKERS', 'localhost:19092').split(','),

  services: {
    gateway: env('GATEWAY_URL', 'http://localhost:8080'),
    merchant: env('MERCHANT_URL', 'http://localhost:4001'),
    payment: env('PAYMENT_URL', 'http://localhost:4002'),
    vault: env('VAULT_URL', 'http://localhost:4003'),
    risk: env('RISK_URL', 'http://localhost:4004'),
    ledger: env('LEDGER_URL', 'http://localhost:4005'),
    webhook: env('WEBHOOK_URL', 'http://localhost:4006'),
    settlement: env('SETTLEMENT_URL', 'http://localhost:4007'),
    bank: env('BANK_SIMULATOR_URL', 'http://localhost:4009'),
  },

  ports: {
    gateway: int('PORT', 8080),
    merchant: int('PORT', 4001),
    payment: int('PORT', 4002),
    vault: int('PORT', 4003),
    risk: int('PORT', 4004),
    ledger: int('PORT', 4005),
    webhook: int('PORT', 4006),
    settlement: int('PORT', 4007),
    bank: int('PORT', 4009),
  },

  otel: {
    enabled: bool('OTEL_ENABLED', false),
    endpoint: env('OTEL_EXPORTER_OTLP_ENDPOINT', 'http://localhost:4318'),
  },
};

export { env, int as envInt, bool as envBool };
