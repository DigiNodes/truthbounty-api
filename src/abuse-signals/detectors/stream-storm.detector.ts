import { AbuseSignalKind, AbuseReasonCode } from '../abuse-signals.types';
import {
  AbuseDetector,
  AbuseDetectorContext,
  ratioConfidence,
} from './abuse-detector';

/**
 * Stream storm detector (PREWAVE-BE-086, #681).
 *
 * A stream storm is resource exhaustion of the *delivery* layer: opening far
 * more connections than a client needs, subscribing in a loop, or flooding the
 * message channel. Three dimensions again:
 *
 *  - `connection_pressure` — live connections above the concurrency cap.
 *  - `subscribe_pressure` — subscribe/unsubscribe churn.
 *  - `message_pressure` — outbound message volume.
 *
 * Connections are counted as `connects - disconnects` and floored at zero so a
 * client that reconnects noisily cannot be read as holding thousands of live
 * sockets. Nothing here inspects stream contents, which is what keeps
 * notification payloads (and anything they embed) out of the abuse module.
 */
export class StreamStormDetector implements AbuseDetector {
  readonly kind = AbuseSignalKind.STREAM_STORM;
  readonly id = 'stream.connection_subscribe_message.v1';

  constructor(
    private readonly options: {
      maxConcurrentConnections: number;
      maxSubscribeOps: number;
      maxMessages: number;
    },
  ) {}

  evaluate(context: AbuseDetectorContext): ReturnType<AbuseDetector['evaluate']> {
    const signals: ReturnType<AbuseDetector['evaluate']> = [];
    const { window } = context;

    const live = Math.max(0, window.streamConnect - window.streamDisconnect);
    if (live > this.options.maxConcurrentConnections) {
      signals.push({
        kind: this.kind,
        reasonCode: AbuseReasonCode.STREAM_CONNECTION_STORM,
        dimension: 'connection_pressure',
        sampleCount: live,
        confidence: ratioConfidence(
          live,
          this.options.maxConcurrentConnections,
        ),
      });
    }

    if (window.streamSubscribeOps > this.options.maxSubscribeOps) {
      signals.push({
        kind: this.kind,
        reasonCode: AbuseReasonCode.STREAM_SUBSCRIBE_STORM,
        dimension: 'subscribe_pressure',
        sampleCount: window.streamSubscribeOps,
        confidence: ratioConfidence(
          window.streamSubscribeOps,
          this.options.maxSubscribeOps,
        ),
      });
    }

    if (window.streamMessages > this.options.maxMessages) {
      signals.push({
        kind: this.kind,
        reasonCode: AbuseReasonCode.STREAM_MESSAGE_STORM,
        dimension: 'message_pressure',
        sampleCount: window.streamMessages,
        confidence: ratioConfidence(
          window.streamMessages,
          this.options.maxMessages,
        ),
      });
    }

    return signals;
  }
}