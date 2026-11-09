# gateways

WebSocket gateways. One namespace, `/assistant`, with a room per user and a
sub-room per device, carrying the pipeline events that drive the orb and the
`sync.changed` fan-out that keeps devices in step.

**The voice gateway does not live here.** It is at
`modules/voice/voice.gateway.ts`, beside the service whose events it
delivers. A transport that only ever carries one module's events is that
module's concern, and splitting it off would mean reading two directories to
follow one flow.

This directory is for a gateway that spans modules — the device-sync fan-out
is the expected first one — which is Chunk 6 work, alongside the Redis
adapter that lets sockets span more than one instance.
