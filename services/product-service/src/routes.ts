import { Router } from 'express';
import { z } from 'zod';
import { AppError } from './http.js';
import { DuplicateSkuError, type ProductRepository } from './repository.js';

const MAX_INT32 = 2_147_483_647;

const idSchema = z.coerce.number().int().positive().max(MAX_INT32);

const paginationSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).max(MAX_INT32).default(0),
});

export const createProductSchema = z.strictObject({
  sku: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9][A-Z0-9-]{2,31}$/, 'SKU must be 3-32 characters: letters, digits and dashes'),
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(1000).optional(),
  priceCents: z.number().int().positive().max(10_000_000),
});

function validationError(error: z.ZodError): AppError {
  return new AppError(
    400,
    'VALIDATION_ERROR',
    'Request validation failed',
    error.issues.map((issue) => ({ field: issue.path.join('.'), message: issue.message })),
  );
}

export function createProductRouter(repository: ProductRepository): Router {
  const router = Router();

  router.get('/', async (req, res) => {
    const page = paginationSchema.safeParse(req.query);
    if (!page.success) throw validationError(page.error);
    const products = await repository.list(page.data);
    res.json({ data: products, pagination: { ...page.data, count: products.length } });
  });

  router.get('/:id', async (req, res) => {
    const id = idSchema.safeParse(req.params.id);
    if (!id.success) throw new AppError(400, 'INVALID_ID', 'Product id must be a positive integer');
    const product = await repository.findById(id.data);
    if (!product) throw new AppError(404, 'PRODUCT_NOT_FOUND', `Product ${id.data} not found`);
    res.json({ data: product });
  });

  router.post('/', async (req, res) => {
    const body = createProductSchema.safeParse(req.body ?? {});
    if (!body.success) throw validationError(body.error);
    try {
      const product = await repository.create(body.data);
      res.status(201).location(`${req.baseUrl}/${product.id}`).json({ data: product });
    } catch (err) {
      if (err instanceof DuplicateSkuError) throw new AppError(409, 'SKU_ALREADY_EXISTS', err.message);
      throw err;
    }
  });

  return router;
}
