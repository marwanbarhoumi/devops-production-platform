import { randomUUID } from 'node:crypto';
import type { ErrorRequestHandler, RequestHandler } from 'express';
import { pinoHttp } from 'pino-http';
import type { Logger } from './logger.js';

export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

const REQUEST_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;
const QUIET_PATHS = new Set(['/health', '/ready', '/metrics']);

/** Structured access log. Reuses a caller-supplied X-Request-Id so requests can be traced across services. */
export function requestLogger(logger: Logger): RequestHandler {
  return pinoHttp({
    logger,
    genReqId: (req, res) => {
      const incoming = req.headers['x-request-id'];
      const id = typeof incoming === 'string' && REQUEST_ID_PATTERN.test(incoming) ? incoming : randomUUID();
      res.setHeader('x-request-id', id);
      return id;
    },
    autoLogging: { ignore: (req) => QUIET_PATHS.has(req.url?.split('?')[0] ?? '') },
    customLogLevel: (_req, res, err) => {
      if (err || res.statusCode >= 500) return 'error';
      if (res.statusCode >= 400) return 'warn';
      return 'info';
    },
    serializers: {
      req: (req: { id: unknown; method: string; url: string }) => ({ id: req.id, method: req.method, url: req.url }),
      res: (res: { statusCode: number }) => ({ statusCode: res.statusCode }),
    },
  });
}

export function requestIdOf(res: { getHeader(name: string): unknown }): string | undefined {
  const id = res.getHeader('x-request-id');
  return typeof id === 'string' ? id : undefined;
}

export const notFoundHandler: RequestHandler = (req, res) => {
  res.status(404).json({
    error: { code: 'NOT_FOUND', message: `Route ${req.method} ${req.path} not found`, requestId: requestIdOf(res) },
  });
};

interface BodyParserError {
  type?: string;
  status?: number;
}

/** Converts errors to a consistent JSON shape. Unexpected errors are logged but never echoed to clients. */
export function errorHandler(logger: Logger): ErrorRequestHandler {
  return (err: unknown, _req, res, _next) => {
    const requestId = requestIdOf(res);

    if (err instanceof AppError) {
      res.status(err.status).json({
        error: { code: err.code, message: err.message, details: err.details, requestId },
      });
      return;
    }

    const parserError = err as BodyParserError;
    if (parserError?.type === 'entity.parse.failed') {
      res.status(400).json({ error: { code: 'INVALID_JSON', message: 'Request body is not valid JSON', requestId } });
      return;
    }
    if (parserError?.type === 'entity.too.large') {
      res.status(413).json({ error: { code: 'PAYLOAD_TOO_LARGE', message: 'Request body is too large', requestId } });
      return;
    }
    if (parserError?.type === 'encoding.unsupported' || parserError?.type === 'charset.unsupported') {
      res.status(415).json({ error: { code: 'UNSUPPORTED_ENCODING', message: 'Unsupported request encoding', requestId } });
      return;
    }

    logger.error({ err, requestId }, 'unhandled error');
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred', requestId } });
  };
}
