export const INKWELL_BACKEND_IDLE_GRACE_SECONDS = 300 as const;

export type BackendRegion =
  | 'ams'
  | 'atl'
  | 'bom'
  | 'cdg'
  | 'dfw'
  | 'ewr'
  | 'fra'
  | 'gru'
  | 'iad'
  | 'jnb'
  | 'lax'
  | 'lhr'
  | 'nrt'
  | 'ord'
  | 'sea'
  | 'sin'
  | 'sjc'
  | 'syd'
  | (string & {});

export type InkwellGameConfig = {
  client: {
    directory: string;
  };
  backend?: {
    entry: string;
    region?: BackendRegion;
    maxConnections?: number;
    resources?: {
      memoryMb?: 256 | 512 | 1024 | 2048;
      sharedCpus?: 1 | 2 | 4;
    };
  };
};

function relativePath(value: unknown, label: string) {
  if (
    typeof value !== 'string' ||
    !value ||
    value.length > 500 ||
    value.startsWith('/') ||
    value.startsWith('\\') ||
    /^[A-Za-z]:[\\/]/.test(value) ||
    value.split(/[\\/]/).some((segment) => segment === '..')
  ) {
    throw new TypeError(`${label} must be a safe relative path.`);
  }
  return value;
}

export function validateGameConfig(value: unknown): InkwellGameConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Inkwell config must be an object.');
  }
  const config = value as Record<string, unknown>;
  const client = config.client as Record<string, unknown> | undefined;
  if (!client || typeof client !== 'object' || Array.isArray(client)) {
    throw new TypeError('Inkwell config requires a client section.');
  }
  const result: InkwellGameConfig = {
    client: { directory: relativePath(client.directory, 'client.directory') },
  };
  if (config.backend === undefined) return result;
  if (
    !config.backend ||
    typeof config.backend !== 'object' ||
    Array.isArray(config.backend)
  ) {
    throw new TypeError('backend must be an object when provided.');
  }
  const backend = config.backend as Record<string, unknown>;
  const maxConnections = backend.maxConnections ?? 100;
  if (
    !Number.isInteger(maxConnections) ||
    (maxConnections as number) < 1 ||
    (maxConnections as number) > 10_000
  ) {
    throw new TypeError('backend.maxConnections must be an integer from 1 to 10,000.');
  }
  if (
    backend.region !== undefined &&
    (typeof backend.region !== 'string' ||
      !/^[a-z][a-z0-9-]{1,15}$/.test(backend.region))
  ) {
    throw new TypeError('backend.region must be a valid region code.');
  }
  let resources: NonNullable<InkwellGameConfig['backend']>['resources'];
  if (backend.resources !== undefined) {
    if (
      !backend.resources ||
      typeof backend.resources !== 'object' ||
      Array.isArray(backend.resources)
    ) {
      throw new TypeError('backend.resources must be an object.');
    }
    const input = backend.resources as Record<string, unknown>;
    const allowedMemory = new Set([256, 512, 1024, 2048]);
    const allowedCpus = new Set([1, 2, 4]);
    if (input.memoryMb !== undefined && !allowedMemory.has(input.memoryMb as number)) {
      throw new TypeError('backend.resources.memoryMb is not supported.');
    }
    if (input.sharedCpus !== undefined && !allowedCpus.has(input.sharedCpus as number)) {
      throw new TypeError('backend.resources.sharedCpus is not supported.');
    }
    resources = {
      ...(input.memoryMb === undefined ? {} : { memoryMb: input.memoryMb as 256 }),
      ...(input.sharedCpus === undefined ? {} : { sharedCpus: input.sharedCpus as 1 }),
    };
  }
  result.backend = {
    entry: relativePath(backend.entry, 'backend.entry'),
    maxConnections: maxConnections as number,
    ...(backend.region === undefined ? {} : { region: backend.region as BackendRegion }),
    ...(resources === undefined ? {} : { resources }),
  };
  return result;
}

export function defineGameConfig<const Config extends InkwellGameConfig>(
  config: Config,
) {
  validateGameConfig(config);
  return config;
}
