import { Injectable, Logger } from '@nestjs/common';
import type { VoiceEvent } from './voice-events';

/** Who an event is for. The gateway turns this into rooms. */
export interface VoiceEventTarget {
  readonly userId: string;
  readonly deviceId: string;
  readonly sessionId: string;
  /**
   * True for events only the originating device should see. Most voice
   * events are device-private: another of the user's devices does not need
   * a partial transcript of what is being said into this one.
   */
  readonly deviceOnly?: boolean;
}

export type VoiceEventListener = (event: VoiceEvent, target: VoiceEventTarget) => void;

/**
 * An in-process publish/subscribe seam between the pipeline and whatever
 * delivers events.
 *
 * It exists so `VoiceService` does not import the socket gateway. That
 * would be a cycle — the gateway needs the service to handle a message —
 * and it would also mean the pipeline could not be tested without a
 * WebSocket server.
 *
 * In-process is the correct scope today: one instance, one set of sockets.
 * When a second instance exists, this is where a Redis adapter goes, and
 * nothing above or below it changes.
 */
@Injectable()
export class VoiceEventBus {
  private readonly logger = new Logger(VoiceEventBus.name);
  private readonly listeners = new Set<VoiceEventListener>();

  subscribe(listener: VoiceEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Delivers to every listener.
   *
   * A listener that throws is logged and skipped. Event delivery must not
   * fail the turn that produced the event: a broken socket is not a reason
   * to lose someone's answer.
   */
  publish(event: VoiceEvent, target: VoiceEventTarget): void {
    for (const listener of this.listeners) {
      try {
        listener(event, target);
      } catch (error) {
        this.logger.error(
          `A voice event listener threw on ${event.type}: ` +
            (error instanceof Error ? error.message : 'unknown error'),
        );
      }
    }
  }
}
