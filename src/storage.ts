export type DatabaseValue = string | number | boolean | null;

export type DatabaseStatement = {
  sql: string;
  params?: DatabaseValue[];
};

export type DatabaseResult<Row extends Record<string, unknown> = Record<string, unknown>> = {
  results: Row[];
  meta: {
    changedRows?: number;
    lastRowId?: number;
    rowsRead?: number;
    rowsWritten?: number;
    durationMs?: number;
  };
};

export type StoredObjectInfo = {
  key: string;
  size: number;
  etag: string;
  uploadedAt: string;
  contentType: string | null;
  metadata: Record<string, string>;
};

export type StoredObjectList = {
  objects: StoredObjectInfo[];
  cursor: string | null;
  truncated: boolean;
};

export class RuntimeServiceError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'RuntimeServiceError';
  }
}

type RuntimeClientOptions = {
  baseUrl: string;
  token: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
};

function validatePath(path: string) {
  if (
    !path ||
    path.length > 500 ||
    path.startsWith('/') ||
    path.includes('\\') ||
    path.split('/').some((segment) => !segment || segment === '.' || segment === '..')
  ) {
    throw new TypeError('Storage keys must be safe relative paths up to 500 characters.');
  }
  return path;
}

function validatePrefix(prefix: string) {
  const value = prefix.endsWith('/') ? prefix.slice(0, -1) : prefix;
  if (value) validatePath(value);
  return prefix;
}

function validateWorldId(worldId: string) {
  if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(worldId)) {
    throw new TypeError(
      'World IDs must be 1-128 letters, numbers, dots, colons, underscores, or hyphens.',
    );
  }
  return worldId;
}

function bodySize(value: BodyInit, declared?: number) {
  if (declared !== undefined) {
    if (!Number.isSafeInteger(declared) || declared < 0) {
      throw new TypeError('Storage object size must be a non-negative safe integer.');
    }
    return declared;
  }
  if (typeof value === 'string') return new TextEncoder().encode(value).byteLength;
  if (value instanceof URLSearchParams) {
    return new TextEncoder().encode(value.toString()).byteLength;
  }
  if (value instanceof Blob) return value.size;
  if (value instanceof ArrayBuffer) return value.byteLength;
  if (ArrayBuffer.isView(value)) return value.byteLength;
  throw new TypeError(
    'Streaming and multipart storage uploads require an explicit size option.',
  );
}

function encodeBase64Utf8(value: string) {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

class RuntimeClient {
  private readonly baseUrl: URL;
  private readonly token: string;
  private readonly fetcher: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: RuntimeClientOptions) {
    this.baseUrl = new URL(options.baseUrl);
    if (!['https:', 'http:'].includes(this.baseUrl.protocol))
      throw new TypeError('Runtime service URL must use HTTP or HTTPS.');
    if (!options.token) throw new TypeError('Runtime service token is required.');
    this.token = options.token;
    this.fetcher = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 15_000;
  }

  async request(path: string, init: RequestInit = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const externalSignal = init.signal;
    const abort = () => controller.abort();
    if (externalSignal?.aborted) controller.abort();
    externalSignal?.addEventListener('abort', abort, { once: true });
    try {
      const headers = new Headers(init.headers);
      headers.set('authorization', `Bearer ${this.token}`);
      const requestInit: RequestInit & { duplex?: 'half' } = {
        ...init,
        signal: controller.signal,
        headers,
      };
      if (init.body instanceof ReadableStream) requestInit.duplex = 'half';
      const response = await this.fetcher(new URL(path, this.baseUrl), requestInit);
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as {
          error?: string;
          code?: string;
        } | null;
        throw new RuntimeServiceError(
          response.status,
          body?.code || 'request_failed',
          body?.error || `Runtime service request failed (${response.status}).`,
        );
      }
      return response;
    } catch (error) {
      if (controller.signal.aborted && !externalSignal?.aborted) {
        throw new RuntimeServiceError(504, 'timeout', 'Runtime service request timed out.');
      }
      throw error;
    } finally {
      clearTimeout(timer);
      externalSignal?.removeEventListener('abort', abort);
    }
  }
}

export class InkwellDatabase {
  constructor(private readonly client: RuntimeClient) {}

  async query<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params: DatabaseValue[] = [],
  ) {
    const [result] = await this.batch<Row>([{ sql, params }]);
    if (!result) throw new RuntimeServiceError(502, 'empty_result', 'Database returned no result.');
    return result;
  }

  async batch<Row extends Record<string, unknown> = Record<string, unknown>>(
    statements: DatabaseStatement[],
  ): Promise<DatabaseResult<Row>[]> {
    if (!statements.length || statements.length > 20)
      throw new TypeError('Database batches must contain 1-20 statements.');
    for (const statement of statements) {
      if (!statement.sql.trim() || statement.sql.length > 100_000)
        throw new TypeError('Database SQL must contain 1-100,000 characters.');
      if ((statement.params?.length ?? 0) > 100)
        throw new TypeError('Database statements accept at most 100 parameters.');
    }
    const response = await this.client.request('/api/v1/runtime/database/query', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ statements }),
    });
    const body = (await response.json()) as { results?: DatabaseResult<Row>[] };
    if (!Array.isArray(body.results))
      throw new RuntimeServiceError(502, 'invalid_response', 'Database returned an invalid response.');
    return body.results;
  }
}

export class InkwellObjectStorage {
  constructor(private readonly client: RuntimeClient) {}

  async put(
    key: string,
    value: BodyInit,
    options: {
      contentType?: string;
      metadata?: Record<string, string>;
      worldId?: string;
      size?: number;
      signal?: AbortSignal;
    } = {},
  ) {
    validatePath(key);
    const headers = new Headers();
    const size = bodySize(value, options.size);
    if (size > 100 * 1024 * 1024) {
      throw new TypeError('Storage objects must be at most 100 MiB.');
    }
    headers.set('x-inkwell-content-length', String(size));
    if (options.contentType) headers.set('content-type', options.contentType);
    if (options.worldId) {
      headers.set('x-inkwell-world-id', validateWorldId(options.worldId));
    }
    if (options.metadata) {
      const entries = Object.entries(options.metadata);
      if (
        entries.length > 32 ||
        entries.some(
          ([name, value]) =>
            !/^[A-Za-z0-9_.-]{1,64}$/.test(name) ||
            typeof value !== 'string' ||
            value.length > 1_024,
        )
      ) {
        throw new TypeError(
          'Storage metadata accepts at most 32 safe keys and 1,024 characters per value.',
        );
      }
      const encoded = encodeBase64Utf8(JSON.stringify(options.metadata));
      if (encoded.length > 8 * 1024) {
        throw new TypeError('Encoded storage metadata must be at most 8 KiB.');
      }
      headers.set('x-inkwell-metadata', encoded);
    }
    const response = await this.client.request(
      `/api/v1/runtime/storage/object?key=${encodeURIComponent(key)}`,
      { method: 'PUT', headers, body: value, signal: options.signal },
    );
    return (await response.json()) as StoredObjectInfo;
  }

  async get(key: string, options: { signal?: AbortSignal } = {}) {
    validatePath(key);
    return this.client.request(
      `/api/v1/runtime/storage/object?key=${encodeURIComponent(key)}`,
      { signal: options.signal },
    );
  }

  async delete(key: string, options: { signal?: AbortSignal } = {}) {
    validatePath(key);
    await this.client.request(
      `/api/v1/runtime/storage/object?key=${encodeURIComponent(key)}`,
      { method: 'DELETE', signal: options.signal },
    );
  }

  async list(options: { prefix?: string; cursor?: string; limit?: number } = {}) {
    if (options.prefix) validatePrefix(options.prefix);
    if (
      options.limit !== undefined &&
      (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 1_000)
    ) {
      throw new TypeError('Storage list limits must be integers from 1 to 1,000.');
    }
    if (options.cursor && options.cursor.length > 2_048) {
      throw new TypeError('Storage cursor is too large.');
    }
    const query = new URLSearchParams();
    if (options.prefix) query.set('prefix', options.prefix);
    if (options.cursor) query.set('cursor', options.cursor);
    if (options.limit) query.set('limit', String(options.limit));
    const response = await this.client.request(
      `/api/v1/runtime/storage?${query.toString()}`,
    );
    return (await response.json()) as StoredObjectList;
  }
}

export function createRuntimeServices(options: Partial<RuntimeClientOptions> = {}) {
  const baseUrl = options.baseUrl ?? process.env.INKWELL_RUNTIME_API_URL;
  const token = options.token ?? process.env.INKWELL_RUNTIME_TOKEN;
  if (!baseUrl || !token) {
    throw new Error(
      'INKWELL_RUNTIME_API_URL and INKWELL_RUNTIME_TOKEN are required in an Inkwell backend.',
    );
  }
  const client = new RuntimeClient({
    baseUrl,
    token,
    fetch: options.fetch,
    timeoutMs: options.timeoutMs,
  });
  return Object.freeze({
    database: new InkwellDatabase(client),
    storage: new InkwellObjectStorage(client),
  });
}
