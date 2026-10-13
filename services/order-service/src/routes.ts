import { Router } from 'express';
import client from 'prom-client';
import { z } from 'zod';
import { AppError, requestIdOf } from './http.js';
import type { Logger } from './logger.js';
import {
  ProductServiceTimeoutError,
  ProductServiceUnavailableError,
  type ProductClient,
  type ProductLookup,
} from './product-client.js';
import type { OrderRepository } from './repository.js';

const MAX_INT32 = 2_147_483_647;
export const MAX_QUANTITY = 1000;

const idSchema = z.coerce.number().int().positive().max(MAX_INT32);

const paginationSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).max(MAX_INT32).default(0),
});

export const createOrderSchema = z.strictObject({
  productId: z.number().int().positive().max(MAX_INT32),
  quantity: z.number().int().min(1).max(MAX_QUANTITY),
});

function validationError(error: z.ZodError): AppError {
  return new AppError(
    400,
    'VALIDATION_ERROR',
    'Request validation failed',
    error.issues.map((issue) => ({ field: issue.path.join('.'), message: issue.message })),
  );
}

export interface OrderRouterDependencies {
  repository: OrderRepository;
  productClient: ProductClient;
  logger: Logger;
  registry: client.Registry;
}

export function createOrderRouter({ repository, productClient, logger, registry }: OrderRouterDependencies): Router {
  const router = Router();

  const ordersCreated = new client.Counter({
    name: 'orders_created_total',
    help: 'Number of orders successfully created',
    registers: [registry],
  });
  const productLookupFailures = new client.Counter({
    name: 'order_product_lookup_failures_total',
    help: 'Failed product validations against product-service, by reason',
    labelNames: ['reason'] as const,
    registers: [registry],
  });

  router.get('/', async (req, res) => {
    const page = paginationSchema.safeParse(req.query);
    if (!page.success) throw validationError(page.error);
    const orders = await repository.list(page.data);
    res.json({ data: orders, pagination: { ...page.data, count: orders.length } });
  });

  router.get('/:id', async (req, res) => {
    const id = idSchema.safeParse(req.params.id);
    if (!id.success) throw new AppError(400, 'INVALID_ID', 'Order id must be a positive integer');
    const order = await repository.findById(id.data);
    if (!order) throw new AppError(404, 'ORDER_NOT_FOUND', `Order ${id.data} not found`);
    res.json({ data: order });
  });

  router.post('/', async (req, res) => {
    const body = createOrderSchema.safeParse(req.body ?? {});
    if (!body.success) throw validationError(body.error);
    const { productId, quantity } = body.data;

    let lookup: ProductLookup;
    try {
      lookup = await productClient.getProduct(productId, requestIdOf(res));
    } catch (err) {
      if (err instanceof ProductServiceTimeoutError) {
        productLookupFailures.inc({ reason: 'timeout' });
        logger.warn({ productId, reason: err.message }, 'product lookup timed out');
        throw new AppError(504, 'PRODUCT_SERVICE_TIMEOUT', 'Product service did not respond in time');
      }
      if (err instanceof ProductServiceUnavailableError) {
        productLookupFailures.inc({ reason: 'unavailable' });
        logger.warn({ productId, reason: err.message }, 'product lookup failed');
        throw new AppError(503, 'PRODUCT_SERVICE_UNAVAILABLE', 'Product service is unavailable');
      }
      throw err;
    }

    if (!lookup.found) {
      productLookupFailures.inc({ reason: 'not_found' });
      throw new AppError(422, 'PRODUCT_NOT_FOUND', `Product ${productId} does not exist`);
    }

    const order = await repository.create({
      productId,
      productSku: lookup.product.sku,
      productName: lookup.product.name,
      quantity,
      unitPriceCents: lookup.product.priceCents,
    });
    ordersCreated.inc();
    res.status(201).location(`${req.baseUrl}/${order.id}`).json({ data: order });
  });

  return router;
}
