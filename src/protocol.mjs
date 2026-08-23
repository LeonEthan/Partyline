import { randomUUID } from "node:crypto";

export const VERSION = 1;
export const MAX_FRAME_BYTES = 128 * 1024;
export const MAX_BODY_BYTES = 16 * 1024;
export const MAX_QUEUE_LENGTH = 100;
export const DEFAULT_TTL_MS = 4 * 60 * 60 * 1000;
export const MAX_AWAIT_MS = 60 * 1000;

export class PartylineError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = "PartylineError";
    this.code = code;
    this.details = details;
  }
}

export function assertString(value, field, { maxBytes = 256, allowEmpty = false } = {}) {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0)) {
    throw new PartylineError("invalid_request", `${field} must be a non-empty string`);
  }
  if (Buffer.byteLength(value, "utf8") > maxBytes) {
    throw new PartylineError("invalid_request", `${field} is too large`);
  }
  if (value.includes("\u0000")) {
    throw new PartylineError("invalid_request", `${field} must not contain NUL`);
  }
  return value;
}

export function assertAlias(value, field = "alias") {
  assertString(value, field, { maxBytes: 128 });
  if (!/^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/.test(value)) {
    throw new PartylineError("invalid_request", `${field} contains unsupported characters`);
  }
  return value;
}

export function frame(value) {
  const line = JSON.stringify(value);
  if (Buffer.byteLength(line, "utf8") > MAX_FRAME_BYTES) {
    throw new PartylineError("frame_too_large", "JSON frame exceeds the maximum size");
  }
  return `${line}\n`;
}

export function lineParser(onValue, { maxBytes = MAX_FRAME_BYTES } = {}) {
  let pending = "";

  return (chunk) => {
    pending += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
    if (Buffer.byteLength(pending, "utf8") > maxBytes) {
      throw new PartylineError("frame_too_large", "JSON frame exceeds the maximum size");
    }

    let newline;
    while ((newline = pending.indexOf("\n")) !== -1) {
      const raw = pending.slice(0, newline).replace(/\r$/, "");
      pending = pending.slice(newline + 1);
      if (!raw.trim()) continue;
      let value;
      try {
        value = JSON.parse(raw);
      } catch {
        throw new PartylineError("invalid_json", "Request is not valid JSON");
      }
      onValue(value);
    }
  };
}

export function messageEnvelope({ from, to, text, conversationId, replyTo = null, expectsReply = false, ttlMs = DEFAULT_TTL_MS }) {
  assertAlias(from, "from");
  assertAlias(to, "to");
  assertString(text, "text", { maxBytes: MAX_BODY_BYTES });

  if (!Number.isInteger(ttlMs) || ttlMs < 1 || ttlMs > 24 * 60 * 60 * 1000) {
    throw new PartylineError("invalid_request", "ttl_ms must be between 1 and 86400000");
  }
  if (conversationId !== undefined && conversationId !== null) {
    assertString(conversationId, "conversation_id", { maxBytes: 128 });
  }
  if (replyTo !== null && replyTo !== undefined) {
    assertString(replyTo, "reply_to", { maxBytes: 128 });
  }

  const now = new Date().toISOString();
  return {
    v: VERSION,
    message_id: `msg_${randomUUID()}`,
    conversation_id: conversationId ?? `conv_${randomUUID()}`,
    from,
    to,
    kind: "message",
    created_at: now,
    ttl_ms: ttlMs,
    expects_reply: Boolean(expectsReply),
    body: { type: "text", text },
    reply_to: replyTo ?? null
  };
}

export function publicMessage(message, deliveryState) {
  return {
    v: message.v,
    message_id: message.message_id,
    conversation_id: message.conversation_id,
    from: message.from,
    to: message.to,
    kind: message.kind,
    created_at: message.created_at,
    ttl_ms: message.ttl_ms,
    expects_reply: message.expects_reply,
    reply_to: message.reply_to,
    delivery_state: deliveryState
  };
}

export function isExpired(message, now = Date.now()) {
  return Date.parse(message.created_at) + message.ttl_ms <= now;
}

export function errorObject(error) {
  if (error instanceof PartylineError) {
    return { code: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) };
  }
  return { code: "internal_error", message: error instanceof Error ? error.message : String(error) };
}
