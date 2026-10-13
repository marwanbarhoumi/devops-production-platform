import { z } from 'zod';

export interface ProductSummary {
  id: number;
  sku: string;
  name: string;
  priceCents: number;
}

export type ProductLookup = { found: true; product: ProductSummary } | { found: false };

export interface ProductClient {
  getProduct(id: number, requestId?: string): Promise<ProductLookup>;
}

export class ProductServiceTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`product-service did not respond within ${timeoutMs}ms`);
    this.name = 'ProductServiceTimeoutError';
  }
}

export class ProductServiceUnavailableError extends Error {
  constructor(reason: string) {
    super(`product-service unavailable: ${reason}`);
    this.name = 'ProductServiceUnavailableError';
  }
}

const productResponseSchema = z.object({
  data: z.object({
    id: z.number().int().positive(),
    sku: z.string().min(1),
    name: z.string().min(1),
    priceCents: z.number().int().positive(),
  }),
});

export class HttpProductClient implements ProductClient {
  constructor(
    private readonly baseUrl: string,
    private readonly timeoutMs: number,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async getProduct(id: number, requestId?: string): Promise<ProductLookup> {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (requestId) headers['x-request-id'] = requestId;

    // The timeout signal covers both the connection and reading the response body.
    const signal = AbortSignal.timeout(this.timeoutMs);
    let response: Response;
    let payload: unknown;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/products/${id}`, { headers, signal });
      if (response.status === 404) {
        await response.body?.cancel();
        return { found: false };
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new ProductServiceUnavailableError(`unexpected status ${response.status}`);
      }
      payload = await response.json();
    } catch (err) {
      if (err instanceof ProductServiceUnavailableError) throw err;
      if (signal.aborted) throw new ProductServiceTimeoutError(this.timeoutMs);
      if (err instanceof SyntaxError) throw new ProductServiceUnavailableError('invalid JSON response');
      throw new ProductServiceUnavailableError(err instanceof Error ? err.message : 'request failed');
    }

    const parsed = productResponseSchema.safeParse(payload);
    if (!parsed.success) throw new ProductServiceUnavailableError('unexpected response shape');
    if (parsed.data.data.id !== id) throw new ProductServiceUnavailableError('response does not match requested id');
    return { found: true, product: parsed.data.data };
  }
}
