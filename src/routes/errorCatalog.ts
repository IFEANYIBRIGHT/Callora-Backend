import { Router, type Request, type Response, type NextFunction } from 'express';
import { getErrorCatalog, getErrorCatalogEntry, isErrorCode, ErrorCode } from '../errors/index.js';
import { NotFoundError } from '../errors/index.js';
import { asyncHandler } from '../utils/asyncHandler.js';

export function createErrorCatalogRouter(): Router {
  const router = Router();

  /**
   * GET /errors — List all error catalog entries
   */
  router.get(
    '/',
    asyncHandler(async (_req: Request, res: Response) => {
      const catalog = getErrorCatalog();
      res.json({ errors: catalog });
    })
  );

  /**
   * GET /errors/:code — Get error catalog entry by code
   */
  router.get(
    '/:code',
    asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
      const code = req.params.code.toUpperCase();
      
      if (!isErrorCode(code)) {
        throw new NotFoundError(`Error code ${code} not found`);
      }

      const entry = getErrorCatalogEntry(code);
      if (!entry) {
        throw new NotFoundError(`Error code ${code} not found`);
      }

      res.json(entry);
    })
  );

  return router;
}

export default createErrorCatalogRouter;