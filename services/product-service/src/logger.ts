import { pino, type Logger, type LevelWithSilent } from 'pino';

export type { Logger };

export function createLogger(service: string, level: LevelWithSilent = 'info'): Logger {
  return pino({
    level,
    base: { service },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      level: (label) => ({ level: label }),
    },
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers.cookie',
        '*.password',
        '*.DB_PASSWORD',
        '*.connectionString',
      ],
      censor: '[REDACTED]',
    },
  });
}
