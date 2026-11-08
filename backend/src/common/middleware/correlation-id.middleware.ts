import { Injectable, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { requestContext } from '../request-context';

export const CORRELATION_ID_HEADER = 'x-correlation-id';

/**
 * Opens a request context and echoes the correlation id back.
 *
 * An inbound id is honoured so a trace can span the mobile client, this
 * service and anything downstream; otherwise one is minted here.
 */
@Injectable()
export class CorrelationIdMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction): void {
    const inbound = req.headers[CORRELATION_ID_HEADER];
    const correlationId =
      (Array.isArray(inbound) ? inbound[0] : inbound)?.slice(0, 64) ||
      requestContext.newCorrelationId();

    res.setHeader(CORRELATION_ID_HEADER, correlationId);
    requestContext.run({ correlationId }, () => next());
  }
}
