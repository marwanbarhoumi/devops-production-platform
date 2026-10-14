import { z } from 'zod';

const port = z.coerce.number().int().min(1).max(65535);
const httpUrl = z.url({ protocol: /^https?$/ }).transform(trimTrailingSlashes);

/** Linear-time equivalent of url.replace(/\/+$/, '') (the regex backtracks on long runs of "/"). */
function trimTrailingSlashes(url: string): string {
  let end = url.length;
  while (end > 0 && url[end - 1] === '/') end -= 1;
  return url.slice(0, end);
}

const configSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: port.default(7002),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  DB_HOST: z.string().min(1),
  DB_PORT: port.default(5432),
  DB_NAME: z.string().min(1),
  DB_USER: z.string().min(1),
  DB_PASSWORD: z.string().min(1),
  DB_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
  DB_STATEMENT_TIMEOUT_MS: z.coerce.number().int().min(100).max(60_000).default(5000),
  PRODUCT_SERVICE_URL: httpUrl,
  PRODUCT_SERVICE_TIMEOUT_MS: z.coerce.number().int().min(100).max(30_000).default(2000),
});

export type Config = z.infer<typeof configSchema>;

export class ConfigError extends Error {
  constructor(public readonly issues: string[]) {
    super(`Invalid configuration: ${issues.join('; ')}`);
    this.name = 'ConfigError';
  }
}

/** Validates environment variables. Error messages reference variable names only, never values. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const result = configSchema.safeParse(env);
  if (!result.success) {
    throw new ConfigError(result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`));
  }
  return result.data;
}
