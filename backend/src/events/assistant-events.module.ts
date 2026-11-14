import { Global, Module } from '@nestjs/common';
import { VoiceEventBus } from '../modules/voice/voice-event-bus';

/**
 * The in-process event seam.
 *
 * Global because it is a seam, not a feature: the voice pipeline publishes
 * transcript and response events, the action executor publishes execution
 * events, and the socket gateway consumes both. Any of those importing
 * another's module to reach the bus would be a cycle — the gateway needs
 * the voice service, which needs the assistant, which needs the executor.
 *
 * This is what `src/events/README.md` described: a module that performs an
 * action does not need to know that a gateway cares.
 */
@Global()
@Module({
  providers: [VoiceEventBus],
  exports: [VoiceEventBus],
})
export class AssistantEventsModule {}
