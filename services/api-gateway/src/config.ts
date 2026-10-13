import { z } from 'zod';

const httpUrl = z.url({ protocol: /^https?$/ }).transform((url) => url.replace(/\/+$/, ''));

const configSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(7000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  PRODUCT_SERVICE_URL: httpUrl,
  ORDER_SERVICE_URL: httpUrl,
  UPSTREAM_TIMEOUT_MS: z.coerce.number().int().min(100).max(60_000).default(5000),
  READINESS_TIMEOUT_MS: z.coerce.number().int().min(100).max(10_000).default(1000),
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
