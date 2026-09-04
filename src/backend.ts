import {
  BACKEND_PROTOCOL_VERSION,
  decodeFrame,
  encodeFrame,
  frameReliablePayload,
  MAX_UNRELIABLE_FRAME_BYTES,
  ReliableFrameDecoder,
  type BackendWireFrame,
  type Delivery,
} from './wire.js';
import { parentOrigin, requestId } from './protocol.js';

export type BackendProtocol = {
  clientEvents: Record<string, unknown>;
  serverEvents: Record<string, unknown>;
  actions: Record<string, { input: unknown; output: unknown }>;
};

export type AnyBackendProtocol = {
  clientEvents: Record<string, unknown>;
  serverEvents: Record<string, unknown>;
  actions: Record<string, { input: unknown; output: unknown }>;
};

type EventName<T> = Extract<keyof T, string>;
type ActionInput<T> = T extends { input: infer Input } ? Input : never;
type ActionOutput<T> = T extends { output: infer Output } ? Output : never;

export type BackendTransportKind = 'webtransport' | 'websocket' | 'custom';

export type UnreliableDelivery = 'native' | 'emulated' | 'unavailable';

export type BackendTransportCapabilities = Readonly<{
  unreliable: UnreliableDelivery;
  maxUnreliableFrameBytes: number;
}>;

export interface BackendTransport {
  readonly kind: BackendTransportKind;
  readonly capabilities: BackendTransportCapabilities;
  setHandlers(handlers: {
    frame(frame: Uint8Array, delivery: Delivery): void;
    close(reason?: Error): void;
  }): void;
  sendReliable(frame: Uint8Array): Promise<void>;
  sendUnreliable(frame: Uint8Array): boolean;
  close(code?: number, reason?: string): void;
}

export class BackendConnectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BackendConnectionError';
  }
}

export class BackendActionError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'BackendActionError';
  }
}

type PendingAction = {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
};

type BackendConnectionOptions = {
  transport?: BackendTransport;
  actionTimeoutMs?: number;
  connectTimeoutMs?: number;
  unreliableFallback?: 'reliable' | 'drop';
  signal?: AbortSignal;
};

type ConnectionDescriptor = {
  url: string;
  transport: 'websocket' | 'webtransport';
  fallbackUrl?: string;
  /** SHA-256 leaf certificate fingerprints, encoded as 64 lowercase hex digits. */
  serverCertificateHashes?: string[];
};

function certificatePins(value: unknown): WebTransportHash[] | undefined {
  if (value === undefined) return undefined;
  if (
    !Array.isArray(value) || value.length < 1 || value.length > 2 ||
    value.some((hash) => typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash))
  ) {
    throw new BackendConnectionError('Invalid backend certificate fingerprints.');
  }
  return value.map((hash: string) => ({
    algorithm: 'sha-256',
    value: Uint8Array.from(hash.match(/../g)!, (byte) => Number.parseInt(byte, 16)).buffer,
  }));
}

function createId() {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : requestId();
}

async function frameBytes(value: unknown) {
  if (typeof value === 'string') return new TextEncoder().encode(value);
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value))
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  if (typeof Blob !== 'undefined' && value instanceof Blob)
    return new Uint8Array(await value.arrayBuffer());
  throw new BackendConnectionError('Received an unsupported backend frame.');
}

export class WebSocketBackendTransport implements BackendTransport {
  readonly kind = 'websocket' as const;
  readonly capabilities: BackendTransportCapabilities;
  private handlers: Parameters<BackendTransport['setHandlers']>[0] = {
    frame: () => undefined,
    close: () => undefined,
  };
  private incoming = Promise.resolve();

  private constructor(
    private readonly socket: WebSocket,
    private readonly unreliableFallback: 'reliable' | 'drop',
  ) {
    this.capabilities = Object.freeze({
      unreliable:
        unreliableFallback === 'reliable' ? ('emulated' as const) : ('unavailable' as const),
      maxUnreliableFrameBytes: MAX_UNRELIABLE_FRAME_BYTES,
    });
    socket.binaryType = 'arraybuffer';
    socket.addEventListener('message', (event) => {
      this.incoming = this.incoming
        .then(async () => this.handlers.frame(await frameBytes(event.data), 'reliable'))
        .catch((error: unknown) =>
          this.handlers.close(
            error instanceof Error ? error : new BackendConnectionError(String(error)),
          ),
        );
    });
    socket.addEventListener('close', (event) => {
      this.handlers.close(
        event.wasClean
          ? undefined
          : new BackendConnectionError(event.reason || 'Backend connection closed.'),
      );
    });
    socket.addEventListener('error', () => {
      this.handlers.close(new BackendConnectionError('Backend connection failed.'));
    });
  }

  static connect(
    url: string,
    timeoutMs: number,
    signal?: AbortSignal,
    unreliableFallback: 'reliable' | 'drop' = 'reliable',
  ) {
    return new Promise<WebSocketBackendTransport>((resolve, reject) => {
      if (typeof WebSocket === 'undefined') {
        reject(new BackendConnectionError('WebSocket is unavailable.'));
        return;
      }
      if (signal?.aborted) {
        reject(new BackendConnectionError('Backend connection was cancelled.'));
        return;
      }
      const socket = new WebSocket(url, 'inkwell.backend.v1');
      const timer = setTimeout(() => {
        socket.close();
        reject(new BackendConnectionError('Backend connection timed out.'));
      }, timeoutMs);
      const abort = () => {
        socket.close();
        reject(new BackendConnectionError('Backend connection was cancelled.'));
      };
      signal?.addEventListener('abort', abort, { once: true });
      socket.addEventListener(
        'open',
        () => {
          clearTimeout(timer);
          signal?.removeEventListener('abort', abort);
          resolve(new WebSocketBackendTransport(socket, unreliableFallback));
        },
        { once: true },
      );
      socket.addEventListener(
        'error',
        () => {
          clearTimeout(timer);
          signal?.removeEventListener('abort', abort);
          reject(new BackendConnectionError('Could not connect to the game backend.'));
        },
        { once: true },
      );
    });
  }

  setHandlers(handlers: Parameters<BackendTransport['setHandlers']>[0]) {
    this.handlers = handlers;
  }

  async sendReliable(frame: Uint8Array) {
    if (this.socket.readyState !== WebSocket.OPEN)
      throw new BackendConnectionError('Backend connection is not open.');
    this.socket.send(frame);
  }

  sendUnreliable(frame: Uint8Array) {
    if (this.unreliableFallback === 'drop') return false;
    if (
      this.socket.readyState !== WebSocket.OPEN ||
      this.socket.bufferedAmount > 64 * 1024
    )
      return false;
    this.socket.send(frame);
    return true;
  }

  close(code = 1000, reason = 'Client closed') {
    this.socket.close(code, reason.slice(0, 123));
  }
}

export class WebTransportBackendTransport implements BackendTransport {
  readonly kind = 'webtransport' as const;
  readonly capabilities: BackendTransportCapabilities;
  private handlers: Parameters<BackendTransport['setHandlers']>[0] = {
    frame: () => undefined,
    close: () => undefined,
  };
  private readonly reliableDecoder = new ReliableFrameDecoder();
  private readonly reliableReader: ReadableStreamDefaultReader<Uint8Array>;
  private readonly reliableWriter: WritableStreamDefaultWriter<Uint8Array>;
  private readonly datagramReader: ReadableStreamDefaultReader<Uint8Array>;
  private readonly datagramWriter: WritableStreamDefaultWriter<Uint8Array>;
  private reliableWrites = Promise.resolve();
  private reading = false;
  private closed = false;

  private constructor(
    private readonly transport: WebTransport,
    stream: WebTransportBidirectionalStream,
    direct: boolean,
  ) {
    this.reliableReader = stream.readable.getReader() as ReadableStreamDefaultReader<Uint8Array>;
    this.reliableWriter = stream.writable.getWriter() as WritableStreamDefaultWriter<Uint8Array>;
    this.datagramReader = transport.datagrams.readable.getReader() as ReadableStreamDefaultReader<Uint8Array>;
    this.datagramWriter = transport.datagrams.writable.getWriter() as WritableStreamDefaultWriter<Uint8Array>;
    this.capabilities = Object.freeze({
      // The legacy gateway still has a TCP runtime hop. Only direct endpoints
      // provide native datagrams all the way to the game server.
      unreliable: direct ? ('native' as const) : ('emulated' as const),
      maxUnreliableFrameBytes: Math.min(
        MAX_UNRELIABLE_FRAME_BYTES,
        transport.datagrams.maxDatagramSize,
      ),
    });
  }

  static async connect(
    url: string,
    timeoutMs: number,
    signal?: AbortSignal,
    serverCertificateHashes?: readonly string[],
  ) {
    const pins = certificatePins(serverCertificateHashes);
    if (typeof WebTransport === 'undefined') {
      throw new BackendConnectionError('WebTransport is unavailable.');
    }
    if (signal?.aborted) {
      throw new BackendConnectionError('Backend connection was cancelled.');
    }
    const target = new URL(url);
    if (target.protocol !== 'https:') {
      throw new BackendConnectionError('WebTransport requires a secure HTTPS URL.');
    }
    const transport = new WebTransport(target, {
      congestionControl: 'low-latency',
      requireUnreliable: true,
      allowPooling: false,
      ...(pins ? { serverCertificateHashes: pins } : {}),
    });
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const aborted = new Promise<never>((_, reject) => {
      controller.signal.addEventListener(
        'abort',
        () =>
          reject(
            new BackendConnectionError(
              signal?.aborted
                ? 'Backend connection was cancelled.'
                : 'Backend connection timed out.',
            ),
          ),
        { once: true },
      );
    });
    try {
      await Promise.race([transport.ready, aborted]);
      const stream = await Promise.race([
        transport.createBidirectionalStream(),
        aborted,
      ]);
      const handshakeWriter = stream.writable.getWriter();
      try {
        await Promise.race([handshakeWriter.write(new Uint8Array(4)), aborted]);
      } finally {
        handshakeWriter.releaseLock();
      }
      return new WebTransportBackendTransport(transport, stream, pins !== undefined);
    } catch (error) {
      transport.close({ closeCode: 1, reason: 'Connection failed' });
      throw error instanceof BackendConnectionError
        ? error
        : new BackendConnectionError('Could not connect to the game backend.');
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    }
  }

  setHandlers(handlers: Parameters<BackendTransport['setHandlers']>[0]) {
    this.handlers = handlers;
    if (this.reading) return;
    this.reading = true;
    void this.readReliable();
    void this.readDatagrams();
    void this.transport.closed
      .then(() => this.finish())
      .catch((error: unknown) => this.finish(asConnectionError(error)));
  }

  sendReliable(frame: Uint8Array) {
    if (this.closed)
      return Promise.reject(new BackendConnectionError('Backend connection is closed.'));
    const payload = frameReliablePayload(frame);
    const write = this.reliableWrites.then(() => this.reliableWriter.write(payload));
    this.reliableWrites = write.catch(() => undefined);
    return write;
  }

  sendUnreliable(frame: Uint8Array) {
    if (
      this.closed ||
      frame.byteLength > this.capabilities.maxUnreliableFrameBytes ||
      (this.datagramWriter.desiredSize ?? 0) <= 0
    ) {
      return false;
    }
    void this.datagramWriter.write(frame).catch((error: unknown) => {
      this.finish(asConnectionError(error));
    });
    return true;
  }

  close(code = 0, reason = 'Client closed') {
    if (this.closed) return;
    this.closed = true;
    this.transport.close({ closeCode: code >>> 0, reason: reason.slice(0, 1024) });
  }

  private async readReliable() {
    try {
      while (!this.closed) {
        const { done, value } = await this.reliableReader.read();
        if (done) break;
        for (const frame of this.reliableDecoder.push(value)) {
          this.handlers.frame(frame, 'reliable');
        }
      }
      this.finish();
    } catch (error) {
      this.finish(asConnectionError(error));
    }
  }

  private async readDatagrams() {
    try {
      while (!this.closed) {
        const { done, value } = await this.datagramReader.read();
        if (done) break;
        this.handlers.frame(value, 'unreliable');
      }
    } catch (error) {
      this.finish(asConnectionError(error));
    }
  }

  private finish(reason?: Error) {
    if (this.closed) return;
    this.closed = true;
    this.handlers.close(reason);
  }
}

function asConnectionError(error: unknown) {
  return error instanceof Error
    ? error
    : new BackendConnectionError(String(error));
}

const MAX_BACKEND_HTTP_BODY_BYTES = 1024 * 1024;
const BACKEND_HTTP_METHODS = new Set([
  'GET',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'HEAD',
  'OPTIONS',
]);
const BLOCKED_BACKEND_HTTP_HEADERS = new Set([
  'authorization',
  'connection',
  'content-length',
  'cookie',
  'host',
  'proxy-authorization',
  'set-cookie',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

function encodeBase64(bytes: Uint8Array) {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function decodeBase64(value: string) {
  if (value.length > Math.ceil((MAX_BACKEND_HTTP_BODY_BYTES * 4) / 3) + 4) {
    throw new BackendConnectionError('Backend response body is over 1 MiB.');
  }
  const binary = atob(value);
  if (binary.length > MAX_BACKEND_HTTP_BODY_BYTES) {
    throw new BackendConnectionError('Backend response body is over 1 MiB.');
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

async function boundedRequestBody(
  body: BodyInit | null | undefined,
  signal?: AbortSignal | null,
) {
  if (body === undefined || body === null) return new Uint8Array();
  const reader = new Response(body).body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    if (signal?.aborted) {
      await reader.cancel().catch(() => undefined);
      throw new BackendConnectionError('Backend request was cancelled.');
    }
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BACKEND_HTTP_BODY_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new BackendConnectionError('Backend request body is over 1 MiB.');
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export async function requestBackend(
  path: string,
  init: RequestInit & { timeoutMs?: number } = {},
) {
  if (typeof window === 'undefined' || window.parent === window) {
    throw new BackendConnectionError('Backend requests require an Inkwell player.');
  }
  const expectedOrigin = parentOrigin();
  if (!expectedOrigin) {
    throw new BackendConnectionError('The Inkwell player origin is not trusted.');
  }
  const method = (init.method || (init.body ? 'POST' : 'GET')).toUpperCase();
  if (!BACKEND_HTTP_METHODS.has(method)) {
    throw new BackendConnectionError('Backend request method is invalid.');
  }
  if (
    typeof path !== 'string' ||
    !path.startsWith('/') ||
    path.startsWith('//') ||
    path.length > 2048 ||
    /[\r\n]/.test(path)
  ) {
    throw new BackendConnectionError('Backend request path is invalid.');
  }
  if ((method === 'GET' || method === 'HEAD') && init.body != null) {
    throw new BackendConnectionError(`${method} backend requests cannot have a body.`);
  }
  const headers = new Headers(init.headers);
  const serializedHeaders: Record<string, string> = {};
  let headerBytes = 0;
  for (const [name, value] of headers) {
    if (
      BLOCKED_BACKEND_HTTP_HEADERS.has(name) ||
      name.startsWith('x-inkwell-')
    ) {
      throw new BackendConnectionError(`Backend request header ${name} is reserved.`);
    }
    headerBytes += name.length + value.length;
    if (Object.keys(serializedHeaders).length >= 64 || headerBytes > 16 * 1024) {
      throw new BackendConnectionError('Backend request headers are too large.');
    }
    serializedHeaders[name] = value;
  }
  const body = encodeBase64(await boundedRequestBody(init.body, init.signal));
  const id = requestId();
  // The first request can wake a fully stopped game server before executing
  // creator code. Keep the default just above the platform's cold-start budget.
  const timeoutMs = init.timeoutMs ?? 110_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) {
    throw new BackendConnectionError('Backend request timeout is invalid.');
  }
  return new Promise<Response>((resolve, reject) => {
    const finish = (result: Response | Error) => {
      clearTimeout(timer);
      init.signal?.removeEventListener('abort', onAbort);
      window.removeEventListener('message', onMessage);
      if (result instanceof Error) reject(result);
      else resolve(result);
    };
    const onAbort = () =>
      finish(new BackendConnectionError('Backend request was cancelled.'));
    const onMessage = (event: MessageEvent) => {
      if (event.source !== window.parent || event.origin !== expectedOrigin) return;
      const message = event.data as {
        source?: unknown;
        version?: unknown;
        type?: unknown;
        payload?: {
          requestId?: unknown;
          response?: { status?: unknown; headers?: unknown; body?: unknown };
          error?: unknown;
        };
      };
      if (
        message?.source !== 'inkwell-platform' ||
        message.version !== 1 ||
        message.type !== 'backend.fetch.result' ||
        message.payload?.requestId !== id
      ) {
        return;
      }
      if (typeof message.payload.error === 'string') {
        finish(new BackendConnectionError(message.payload.error));
        return;
      }
      const response = message.payload.response;
      if (
        !response ||
        typeof response.status !== 'number' ||
        !Number.isInteger(response.status) ||
        response.status < 200 ||
        response.status > 599 ||
        !response.headers ||
        typeof response.headers !== 'object' ||
        typeof response.body !== 'string'
      ) {
        finish(new BackendConnectionError('Invalid backend response.'));
        return;
      }
      try {
        const responseBody = decodeBase64(response.body);
        finish(
          new Response(responseBody.byteLength ? responseBody : null, {
            status: response.status,
            headers: response.headers as Record<string, string>,
          }),
        );
      } catch {
        finish(new BackendConnectionError('Invalid backend response.'));
      }
    };
    const timer = setTimeout(
      () => finish(new BackendConnectionError('Backend request timed out.')),
      timeoutMs,
    );
    if (init.signal?.aborted) {
      finish(new BackendConnectionError('Backend request was cancelled.'));
      return;
    }
    init.signal?.addEventListener('abort', onAbort, { once: true });
    window.addEventListener('message', onMessage);
    window.parent.postMessage(
      {
        source: 'inkwell-sdk',
        version: 1,
        type: 'backend.fetch',
        payload: {
          requestId: id,
          request: { method, path, headers: serializedHeaders, body },
        },
        sentAt: Date.now(),
      },
      expectedOrigin,
    );
  });
}

async function requestConnection(timeoutMs: number): Promise<ConnectionDescriptor> {
  if (typeof window === 'undefined' || window.parent === window)
    throw new BackendConnectionError('Backend connections require an Inkwell player.');
  const expectedOrigin = parentOrigin();
  if (!expectedOrigin)
    throw new BackendConnectionError('The Inkwell player origin is not trusted.');
  const id = requestId();
  return new Promise((resolve, reject) => {
    const finish = (result: ConnectionDescriptor | Error) => {
      clearTimeout(timer);
      window.removeEventListener('message', onMessage);
      if (result instanceof Error) reject(result);
      else resolve(result);
    };
    const onMessage = (event: MessageEvent) => {
      if (event.source !== window.parent || event.origin !== expectedOrigin) return;
      const message = event.data as {
        source?: unknown;
        version?: unknown;
        type?: unknown;
        payload?: {
          requestId?: unknown;
          connection?: Partial<ConnectionDescriptor>;
          descriptor?: Partial<ConnectionDescriptor>;
          error?: unknown;
        };
      };
      if (
        message?.source !== 'inkwell-platform' ||
        message.version !== 1 ||
        message.type !== 'backend.result' ||
        message.payload?.requestId !== id
      )
        return;
      if (typeof message.payload.error === 'string') {
        finish(new BackendConnectionError(message.payload.error));
        return;
      }
      const descriptor = message.payload.descriptor ?? message.payload.connection;
      if (
        !descriptor ||
        typeof descriptor.url !== 'string' ||
        (descriptor.transport !== 'websocket' &&
          descriptor.transport !== 'webtransport')
      ) {
        finish(new BackendConnectionError('Invalid backend connection response.'));
        return;
      }
      if (
        descriptor.fallbackUrl !== undefined &&
        typeof descriptor.fallbackUrl !== 'string'
      ) {
        finish(new BackendConnectionError('Invalid backend fallback response.'));
        return;
      }
      try {
        certificatePins(descriptor.serverCertificateHashes);
        if (descriptor.serverCertificateHashes !== undefined &&
            (descriptor.transport !== 'webtransport' || descriptor.fallbackUrl !== undefined)) {
          throw new BackendConnectionError('A pinned backend requires direct WebTransport.');
        }
      } catch (error) {
        finish(asConnectionError(error));
        return;
      }
      finish(descriptor as ConnectionDescriptor);
    };
    const timer = setTimeout(
      () => finish(new BackendConnectionError('Backend startup timed out.')),
      timeoutMs,
    );
    window.addEventListener('message', onMessage);
    window.parent.postMessage(
      {
        source: 'inkwell-sdk',
        version: 1,
        type: 'backend.connect',
        payload: { requestId: id },
        sentAt: Date.now(),
      },
      expectedOrigin,
    );
  });
}

export class BackendConnection<Protocol extends BackendProtocol = AnyBackendProtocol> {
  private readonly handlers = new Map<string, Set<(payload: unknown) => void>>();
  private readonly pending = new Map<string, PendingAction>();
  private closed = false;

  constructor(
    private readonly transport: BackendTransport,
    private readonly actionTimeoutMs = 10_000,
  ) {
    transport.setHandlers({
      frame: (bytes, delivery) => this.receive(bytes, delivery),
      close: (reason) => this.handleClose(reason),
    });
  }

  get transportKind() {
    return this.transport.kind;
  }

  get capabilities() {
    return this.transport.capabilities;
  }

  on<Name extends EventName<Protocol['serverEvents']>>(
    name: Name,
    handler: (payload: Protocol['serverEvents'][Name]) => void,
  ) {
    const key = String(name);
    const handlers = this.handlers.get(key) ?? new Set();
    handlers.add(handler as (payload: unknown) => void);
    this.handlers.set(key, handlers);
    return () => {
      handlers.delete(handler as (payload: unknown) => void);
      if (!handlers.size) this.handlers.delete(key);
    };
  }

  sendReliable<Name extends EventName<Protocol['clientEvents']>>(
    name: Name,
    payload: Protocol['clientEvents'][Name],
  ) {
    this.assertOpen();
    return this.transport.sendReliable(
      encodeFrame(
        {
          version: BACKEND_PROTOCOL_VERSION,
          kind: 'event',
          name: String(name),
          payload,
        },
        'reliable',
      ),
    );
  }

  sendUnreliable<Name extends EventName<Protocol['clientEvents']>>(
    name: Name,
    payload: Protocol['clientEvents'][Name],
  ) {
    this.assertOpen();
    return this.transport.sendUnreliable(
      encodeFrame(
        {
          version: BACKEND_PROTOCOL_VERSION,
          kind: 'event',
          name: String(name),
          payload,
        },
        'unreliable',
      ),
    );
  }

  action<Name extends EventName<Protocol['actions']>>(
    name: Name,
    payload: ActionInput<Protocol['actions'][Name]>,
    options: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<ActionOutput<Protocol['actions'][Name]>> {
    this.assertOpen();
    if (options.signal?.aborted) {
      return Promise.reject(
        new BackendActionError('cancelled', 'Action was cancelled.'),
      );
    }
    if (this.pending.size >= 128)
      return Promise.reject(new BackendConnectionError('Too many pending actions.'));
    const id = createId();
    const timeoutMs = options.timeoutMs ?? this.actionTimeoutMs;
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        const pending = this.pending.get(id);
        if (pending) clearTimeout(pending.timer);
        this.pending.delete(id);
        options.signal?.removeEventListener('abort', abort);
      };
      const abort = () => {
        cleanup();
        reject(new BackendActionError('cancelled', 'Action was cancelled.'));
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new BackendActionError('timeout', `Action ${String(name)} timed out.`));
      }, timeoutMs);
      this.pending.set(id, {
        timer,
        resolve: (value) => {
          cleanup();
          resolve(value as ActionOutput<Protocol['actions'][Name]>);
        },
        reject: (error) => {
          cleanup();
          reject(error);
        },
      });
      options.signal?.addEventListener('abort', abort, { once: true });
      void this.transport
        .sendReliable(
          encodeFrame({
            version: BACKEND_PROTOCOL_VERSION,
            kind: 'action.request',
            id,
            name: String(name),
            payload,
          }),
        )
        .catch((error: unknown) => {
          cleanup();
          reject(
            error instanceof Error
              ? error
              : new BackendConnectionError(String(error)),
          );
        });
    });
  }

  close(code?: number, reason?: string) {
    if (this.closed) return;
    this.closed = true;
    this.transport.close(code, reason);
    this.rejectPending(new BackendConnectionError('Backend connection closed.'));
  }

  private receive(bytes: Uint8Array, _delivery: Delivery) {
    if (this.closed) return;
    const frame = decodeFrame(bytes, _delivery);
    if (frame.kind === 'event') {
      for (const handler of this.handlers.get(frame.name) ?? []) {
        queueMicrotask(() => handler(frame.payload));
      }
      return;
    }
    if (frame.kind === 'action.result') {
      this.pending.get(frame.id)?.resolve(frame.payload);
      return;
    }
    if (frame.kind === 'action.error') {
      this.pending
        .get(frame.id)
        ?.reject(new BackendActionError(frame.error.code, frame.error.message));
    }
  }

  private handleClose(reason?: Error) {
    if (this.closed) return;
    this.closed = true;
    this.rejectPending(
      reason ?? new BackendConnectionError('Backend connection closed.'),
    );
  }

  private rejectPending(error: Error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private assertOpen() {
    if (this.closed) throw new BackendConnectionError('Backend connection is closed.');
  }
}

export async function connectBackend<
  Protocol extends BackendProtocol = AnyBackendProtocol,
>(options: BackendConnectionOptions = {}) {
  const connectTimeoutMs = options.connectTimeoutMs ?? 60_000;
  let transport = options.transport;
  if (!transport) {
    const descriptor = await requestConnection(connectTimeoutMs);
    if (descriptor.transport === 'webtransport') {
      try {
        transport = await WebTransportBackendTransport.connect(
          descriptor.url,
          connectTimeoutMs,
          options.signal,
          descriptor.serverCertificateHashes,
        );
      } catch (error) {
        if (descriptor.serverCertificateHashes !== undefined || !descriptor.fallbackUrl) throw error;
        transport = await WebSocketBackendTransport.connect(
          descriptor.fallbackUrl,
          connectTimeoutMs,
          options.signal,
          options.unreliableFallback,
        );
      }
    } else {
      transport = await WebSocketBackendTransport.connect(
        descriptor.url,
        connectTimeoutMs,
        options.signal,
        options.unreliableFallback,
      );
    }
  }
  return new BackendConnection<Protocol>(transport, options.actionTimeoutMs);
}

export const backend = Object.freeze({ connect: connectBackend, request: requestBackend });
