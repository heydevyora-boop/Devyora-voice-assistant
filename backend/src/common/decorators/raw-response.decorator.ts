import { SetMetadata } from '@nestjs/common';

export const RAW_RESPONSE = 'devyora:raw-response';

/**
 * Opt a route out of the success envelope.
 *
 * Reserved for responses another system parses — health probes, webhooks,
 * file streams — where an extra wrapper would break the consumer.
 */
export const RawResponse = () => SetMetadata(RAW_RESPONSE, true);
