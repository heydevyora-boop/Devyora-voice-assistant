# gateways

WebSocket gateways. One namespace, `/assistant`, with a room per user and a
sub-room per device, carrying the pipeline events that drive the orb and the
`sync.changed` fan-out that keeps devices in step.

Populated in Chunk 6.
