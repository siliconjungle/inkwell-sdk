export const BACKEND_PROTOCOL_VERSION = 1 as const;
export const MAX_RELIABLE_FRAME_BYTES = 64 * 1024;
export const MAX_UNRELIABLE_FRAME_BYTES = 1_200;
export const MAX_ACTION_ID_LENGTH = 128;

export type Delivery = 'reliable' | 'unreliable';

export type BackendWireFrame =
  | {
      version: typeof BACKEND_PROTOCOL_VERSION;
      kind: 'event';
      name: string;
      payload: unknown;
    }
  | {
      version: typeof BACKEND_PROTOCOL_VERSION;
      kind: 'action.request';
      id: string;
      name: string;
      payload: unknown;
    }
  | {
      version: typeof BACKEND_PROTOCOL_VERSION;
      kind: 'action.result';
      id: string;
      payload: unknown;
    }
  | {
      version: typeof BACKEND_PROTOCOL_VERSION;
      kind: 'action.error';
      id: string;
      error: { code: string; message: string };
    };

const encoder = new TextEncoder();
const decoder = new TextDecoder(undefined, { fatal: true });
const NAME_PATTERN = /^[a-z][a-z0-9]*(?:[.:-][a-z0-9]+)*$/i;
const ACTION_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

export class BackendProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BackendProtocolError';
  }
}

export function validateMessageName(name: string) {
  if (!NAME_PATTERN.test(name) || name.length > 80) {
    throw new BackendProtocolError(
      'Message names must be 1-80 letters, numbers, dots, colons, or hyphens.',
    );
  }
  return name;
}

export function encodeFrame(
  frame: BackendWireFrame,
  delivery: 'reliable' | 'unreliable' = 'reliable',
) {
  let serialised: string;
  try {
    serialised = JSON.stringify(frame);
  } catch {
    throw new BackendProtocolError('Message payload must be JSON serialisable.');
  }
  if (serialised === undefined) {
    throw new BackendProtocolError('Message payload must be JSON serialisable.');
  }
  const bytes = encoder.encode(serialised);
  const maximum =
    delivery === 'unreliable'
      ? MAX_UNRELIABLE_FRAME_BYTES
      : MAX_RELIABLE_FRAME_BYTES;
  if (bytes.byteLength > maximum) {
    throw new BackendProtocolError(
      `${delivery} messages must be at most ${maximum} encoded bytes.`,
    );
  }
  return bytes;
}

function hasString(value: Record<string, unknown>, key: string) {
  return typeof value[key] === 'string' && value[key].length > 0;
}

function hasActionId(value: Record<string, unknown>) {
  return (
    hasString(value, 'id') &&
    (value.id as string).length <= MAX_ACTION_ID_LENGTH &&
    ACTION_ID_PATTERN.test(value.id as string)
  );
}

export function decodeFrame(
  bytes: ArrayBuffer | Uint8Array,
  delivery: Delivery = 'reliable',
): BackendWireFrame {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const maximum =
    delivery === 'unreliable'
      ? MAX_UNRELIABLE_FRAME_BYTES
      : MAX_RELIABLE_FRAME_BYTES;
  if (!view.byteLength || view.byteLength > maximum) {
    throw new BackendProtocolError('Invalid backend frame size.');
  }
  let value: unknown;
  try {
    value = JSON.parse(decoder.decode(view));
  } catch {
    throw new BackendProtocolError('Backend frame is not valid JSON.');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new BackendProtocolError('Backend frame must be an object.');
  }
  const frame = value as Record<string, unknown>;
  if (frame.version !== BACKEND_PROTOCOL_VERSION) {
    throw new BackendProtocolError('Unsupported backend protocol version.');
  }
  if (frame.kind === 'event' && hasString(frame, 'name')) {
    validateMessageName(frame.name as string);
    return frame as BackendWireFrame;
  }
  if (
    frame.kind === 'action.request' &&
    hasActionId(frame) &&
    hasString(frame, 'name')
  ) {
    validateMessageName(frame.name as string);
    return frame as BackendWireFrame;
  }
  if (frame.kind === 'action.result' && hasActionId(frame)) {
    return frame as BackendWireFrame;
  }
  if (
    frame.kind === 'action.error' &&
    hasActionId(frame) &&
    frame.error &&
    typeof frame.error === 'object' &&
    hasString(frame.error as Record<string, unknown>, 'code') &&
    hasString(frame.error as Record<string, unknown>, 'message')
  ) {
    const error = frame.error as Record<string, unknown>;
    if (
      (error.code as string).length > 80 ||
      (error.message as string).length > 500
    ) {
      throw new BackendProtocolError('Backend action error is too large.');
    }
    return frame as BackendWireFrame;
  }
  throw new BackendProtocolError('Unknown or malformed backend frame.');
}

export function frameReliablePayload(bytes: Uint8Array) {
  if (bytes.byteLength > MAX_RELIABLE_FRAME_BYTES) {
    throw new BackendProtocolError('Reliable frame exceeds the maximum size.');
  }
  const framed = new Uint8Array(bytes.byteLength + 4);
  new DataView(framed.buffer).setUint32(0, bytes.byteLength);
  framed.set(bytes, 4);
  return framed;
}

export class ReliableFrameDecoder {
  private buffered = new Uint8Array(0);

  push(chunk: Uint8Array) {
    const next = new Uint8Array(this.buffered.byteLength + chunk.byteLength);
    next.set(this.buffered);
    next.set(chunk, this.buffered.byteLength);
    this.buffered = next;
    const frames: Uint8Array[] = [];
    while (this.buffered.byteLength >= 4) {
      const size = new DataView(
        this.buffered.buffer,
        this.buffered.byteOffset,
        4,
      ).getUint32(0);
      if (!size || size > MAX_RELIABLE_FRAME_BYTES) {
        throw new BackendProtocolError('Invalid reliable frame length.');
      }
      if (this.buffered.byteLength < size + 4) break;
      frames.push(this.buffered.slice(4, size + 4));
      this.buffered = this.buffered.slice(size + 4);
    }
    return frames;
  }
}
