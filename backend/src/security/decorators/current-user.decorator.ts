import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import { AppError } from '../../common/errors/app-error';
import type { AuthenticatedPrincipal, AuthenticatedRequest } from '../guards/jwt-auth.guard';

/**
 * The authenticated principal, as established by the guard.
 *
 * Identity is read from here and never from a request body or a header the
 * client controls, so a handler cannot be tricked into acting as another
 * user by a crafted payload.
 */
export const CurrentUser = createParamDecorator(
  (field: keyof AuthenticatedPrincipal | undefined, context: ExecutionContext) => {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const principal = request.principal;

    /* istanbul ignore next — the guard runs first; this is a safety net */
    if (!principal) throw AppError.unauthenticated();

    return field ? principal[field] : principal;
  },
);
