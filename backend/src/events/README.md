# events

Domain events published inside the process — `action.completed`,
`reminder.fired`, `device.revoked` — and the handlers that react to them.

Keeps modules from calling into each other directly: the module that performs
an action does not need to know that a gateway and a notifier both care.

Populated in Chunk 6.
