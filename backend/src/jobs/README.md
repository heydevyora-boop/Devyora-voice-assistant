# jobs

BullMQ queues and processors: reminder firing, push dispatch, token refresh,
retention sweeps and action retries.

Durable background work lives here rather than in a request handler, so it
survives a restart and can be retried with backoff.

Populated in Chunk 6, once Redis is introduced.
