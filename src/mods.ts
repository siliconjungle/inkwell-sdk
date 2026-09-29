/** Metadata-only mod publishing. This module does not use the game iframe bridge. */
export type ModVisibility = 'draft' | 'unlisted' | 'public';
export type ModMediaLink = { url: string; caption: string };
export type ModMetadata = {
  title: string;
  baseGame: string;
  description?: string;
  compatibility?: string;
  tags?: string[];
  repositoryUrl?: string | null;
  projectUrl?: string | null;
  downloadUrl?: string | null;
  coverUrl?: string | null;
  screenshots?: ModMediaLink[];
  videos?: ModMediaLink[];
  descriptionMarkdown?: string;
  installationMarkdown?: string;
  visibility?: ModVisibility;
};
export type ModCreateInput = ModMetadata & { slug: string; rightsConfirmed?: boolean };
export type ModUpdateInput = Partial<ModMetadata> & { revision: number; rightsConfirmed?: boolean };
export type PublicMod = Required<ModMetadata> & { slug: string; publicId: string; publisherUsername: string; createdAt: string; updatedAt: string };
export type OwnedMod = Omit<PublicMod, 'publisherUsername'> & { revision: number; rightsConfirmedAt: string | null; takenDownAt: string | null; takedownReason: string | null };
export type ModPage<T> = { mods: T[]; nextOffset: number | null };
export class ModApiError extends Error {
  constructor(message: string, public readonly status: number) { super(message); this.name = 'ModApiError'; }
}
export type ModClientOptions = {
  /** Server/CLI secret. Never include a developer token in browser code. */
  token?: string;
  apiUrl?: string;
  fetch?: typeof globalThis.fetch;
};

/** Public catalog reads need no token. Owner operations require a server-side developer token. */
export function createModClient(options: ModClientOptions = {}) {
  const base = new URL(options.apiUrl || 'https://inkwell.ing');
  if (base.username || base.password || base.search || base.hash || base.pathname !== '/' ||
      (base.protocol !== 'https:' && !(base.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname))))
    throw new Error('apiUrl must be an HTTPS origin (or localhost for development).');
  if (options.token && typeof window !== 'undefined') throw new Error('Developer tokens must only be used on a server or in a CLI.');
  const fetcher = options.fetch || globalThis.fetch;
  async function request<T>(path: string, owned: boolean, method = 'GET', body?: unknown): Promise<T> {
    if (owned && !options.token?.trim()) throw new Error('A developer token is required for owned mod operations.');
    const response = await fetcher(new URL(path, base), {
      method, redirect: 'error', credentials: 'omit',
      headers: { accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(owned ? { authorization: `Bearer ${options.token}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const data = await response.json() as { error?: string };
    if (!response.ok) throw new ModApiError(data.error || `Mod request failed (${response.status}).`, response.status);
    return data as T;
  }
  function slugPath(slug: string) {
    if (slug.length < 3 || slug.length > 64 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) throw new Error('Invalid mod slug.');
    return encodeURIComponent(slug);
  }
  function pageOffset(offset = 0) {
    if (!Number.isInteger(offset) || offset < 0 || offset > 999999) throw new Error('Offset must be 0–999999.');
    return String(offset);
  }
  return Object.freeze({
    browse(query: { q?: string; baseGame?: string; offset?: number } = {}) {
      const params = new URLSearchParams({ offset: pageOffset(query.offset) });
      if (query.q) params.set('q', query.q); if (query.baseGame) params.set('baseGame', query.baseGame);
      return request<ModPage<PublicMod>>(`/api/v1/catalog/mods?${params}`, false);
    },
    getPublic(slug: string) { return request<{ mod: PublicMod }>(`/api/v1/catalog/mods/${slugPath(slug)}`, false); },
    list(offset = 0) { return request<ModPage<OwnedMod>>(`/api/v1/mods?offset=${pageOffset(offset)}`, true); },
    get(slug: string) { return request<{ mod: OwnedMod }>(`/api/v1/mods/${slugPath(slug)}`, true); },
    create(input: ModCreateInput) { return request<{ mod: OwnedMod }>('/api/v1/mods', true, 'POST', input); },
    update(slug: string, input: ModUpdateInput) { return request<{ mod: OwnedMod }>(`/api/v1/mods/${slugPath(slug)}`, true, 'PATCH', input); },
    remove(slug: string) { return request<{ deleted: true }>(`/api/v1/mods/${slugPath(slug)}`, true, 'DELETE'); },
  });
}
