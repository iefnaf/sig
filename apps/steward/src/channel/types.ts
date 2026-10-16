// Channel abstraction (steward.md §9.3): channels are replaceable behind this narrow
// interface; Feishu is the first implementation. The DO owns dedup, the outbound queue, and
// pacing; the adapter only verifies/parses inbound HTTP, sends one message, and fetches
// attachments.

export type Channel = "feishu";

/** Feishu tenant brand: picks both the accounts domain (device flow) and the open-API domain. */
export type Brand = "feishu" | "lark";

/** An accepted inbound event; `msgId` is the caller's dedup key (§9.1, §11). */
export interface InboundEvent {
  kind: "message" | "card_action" | "other";
  msgId: string;
  eventId: string;
  eventType: string;
  /** The sender's provider identity (Feishu `open_id`); absent on non-message events. */
  senderId?: string;
  chatType?: "p2p" | "group";
  messageType?: string;
  text?: string;
  /** Quoted message id — the strongest routing signal (steward.md §3.1). */
  parentId?: string;
  createAt?: number;
  /** Card callbacks: who clicked. */
  operatorId?: string;
  /** Card callbacks: the button's value action (identity never rides in the button). */
  action?: string;
  /** Card callbacks: the card's message id — resolves the Thread via providerMsgId (§3.1). */
  cardMsgId?: string;
  raw: unknown;
}

export interface OutboundMessage {
  /** Stable queue id; reused across retries and passed as the provider dedup uuid. */
  id: string;
  to: string;
  kind: "text" | "card";
  text?: string;
  card?: unknown;
  threadId?: string | null;
}

export interface AttachmentRef {
  messageId: string;
  fileKey: string;
  type?: "image" | "file";
}

export interface ChannelAdapter {
  /**
   * Verifies the request (token, timestamp skew), answers the `url_verification` handshake,
   * and parses the body into one InboundEvent. Returns a Response instead when the request
   * must be answered directly (handshake echo, rejection).
   */
  verifyAndParse(req: Request): Promise<InboundEvent | Response>;
  /** Sends one message; throws on failure. Retriable failures throw `RetriableChannelError`. */
  send(out: OutboundMessage): Promise<{ providerMsgId: string }>;
  fetchAttachment(ref: AttachmentRef): Promise<Uint8Array>;
}

/** Thrown for failures the queue should retry (network, timeout, provider 5xx/429). */
export class RetriableChannelError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "RetriableChannelError";
  }
}

/** Thrown when the serialized message exceeds the provider cap — never retried. */
export class MessageTooLargeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MessageTooLargeError";
  }
}
