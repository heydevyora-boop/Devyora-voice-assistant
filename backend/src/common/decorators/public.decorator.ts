import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC = 'devyora:is-public';

/**
 * Marks a route as reachable without authentication.
 *
 * The authentication guard arrives in Chunk 3 and will be registered
 * globally, which makes every route private by default — a route is only
 * open if it says so here. Declaring the marker now means the handful of
 * genuinely public routes (health, docs, login) are already annotated and
 * nothing is accidentally exposed when the guard is switched on.
 */
export const Public = () => SetMetadata(IS_PUBLIC, true);
