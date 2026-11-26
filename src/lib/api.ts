import { auth } from './firebase';

const SESSION_TOKEN_KEY = 'sbit_auth_token';
const OFFLINE_CACHE_PREFIX = 'sbit_offline_cache:';
const SYNC_CHANNEL_NAME = 'sbit-sync';
const SYNC_STORAGE_KEY = 'sbit_sync_ping';

function readStoredToken(): string | null {
  try {
    if (typeof window !== 'undefined') {
      return (
        window.localStorage?.getItem(SESSION_TOKEN_KEY) ||
        window.sessionStorage?.getItem(SESSION_TOKEN_KEY) ||
        null
      );
    }
  } catch {
    // Ignore storage restrictions in embedded iframes
  }
  return null;
}

function clearOfflineCache(): void {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return;
    const keysToRemove: string[] = [];
    for (let i = 0; i < window.localStorage.length; i++) {
      const k = window.localStorage.key(i);
      if (k && k.startsWith(OFFLINE_CACHE_PREFIX)) {
        keysToRemove.push(k);
      }
    }
    for (const k of keysToRemove) {
      window.localStorage.removeItem(k);
    }
  } catch {
    // Ignore storage restrictions
  }
}

// Persistent bearer token holder (survives closing/reopening browser; cleared on logout)
let currentBearerToken: string | null = readStoredToken();

export function setAuthToken(token: string | null) {
  currentBearerToken = token;
  try {
    if (typeof window !== 'undefined') {
      if (token) {
        window.localStorage?.setItem(SESSION_TOKEN_KEY, token);
        window.sessionStorage?.setItem(SESSION_TOKEN_KEY, token);
      } else {
        window.localStorage?.removeItem(SESSION_TOKEN_KEY);
        window.sessionStorage?.removeItem(SESSION_TOKEN_KEY);
        clearOfflineCache();
      }
    }
  } catch {
    // Ignore storage restrictions
  }
}

export function getAuthToken(): string | null {
  if (!currentBearerToken) {
    currentBearerToken = readStoredToken();
  }
  return currentBearerToken;
}

export type SyncEventType =
  | 'REGISTRATION_SUBMITTED'
  | 'ATTENDANCE_MARKED'
  | 'SETTINGS_UPDATED'
  | 'DATA_UPDATED';

export function broadcastDataChange(type: SyncEventType): void {
  const payload = { type, ts: Date.now() };
  try {
    if (typeof BroadcastChannel !== 'undefined') {
      const ch = new BroadcastChannel(SYNC_CHANNEL_NAME);
      ch.postMessage(payload);
      ch.close();
    }
  } catch {
    // Ignore BroadcastChannel errors
  }
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      window.localStorage.setItem(SYNC_STORAGE_KEY, JSON.stringify(payload));
    }
  } catch {
    // Ignore storage errors
  }
}

export function subscribeDataChange(handler: (type: SyncEventType) => void): () => void {
  let ch: BroadcastChannel | null = null;
  let lastSeenTs = 0;

  const emitOnce = (raw: unknown) => {
    if (!raw || typeof raw !== 'object') return;
    const obj = raw as { type?: SyncEventType; ts?: number };
    if (!obj.type) return;
    const ts = typeof obj.ts === 'number' ? obj.ts : Date.now();
    if (ts <= lastSeenTs) return;
    lastSeenTs = ts;
    handler(obj.type);
  };

  try {
    if (typeof BroadcastChannel !== 'undefined') {
      ch = new BroadcastChannel(SYNC_CHANNEL_NAME);
      ch.onmessage = (ev) => emitOnce(ev.data);
    }
  } catch {
    // Ignore
  }

  const onStorage = (ev: StorageEvent) => {
    if (ev.key === SYNC_STORAGE_KEY && ev.newValue) {
      try {
        emitOnce(JSON.parse(ev.newValue));
      } catch {
        // Ignore malformed payloads
      }
    }
  };

  if (typeof window !== 'undefined') {
    window.addEventListener('storage', onStorage);
  }

  return () => {
    try {
      ch?.close();
    } catch {
      // Ignore
    }
    if (typeof window !== 'undefined') {
      window.removeEventListener('storage', onStorage);
    }
  };
}

export class ApiError extends Error {
  status: number;
  code?: string;
  details?: Record<string, unknown>;

  constructor(message: string, status: number, code?: string, details?: Record<string, unknown>) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function getUserCacheScope(token: string | null): string {
  if (auth.currentUser?.uid) {
    return `uid:${auth.currentUser.uid}`;
  }
  if (!token) return 'public';
  try {
    const parts = token.split('.');
    if (parts.length >= 2) {
      const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
      const jsonStr = atob(b64.padEnd(Math.ceil(b64.length / 4) * 4, '='));
      const payload = JSON.parse(jsonStr) as Record<string, unknown>;
      const idPart = payload.user_id || payload.sub || payload.profileId || payload.email;
      if (typeof idPart === 'string' && idPart) {
        return `u:${idPart}`;
      }
    }
  } catch {
    // Fallback below
  }
  let h = 2166136261;
  for (let i = 0; i < token.length; i++) {
    h ^= token.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return `t:${(h >>> 0).toString(16)}`;
}

function buildOfflineCacheKey(path: string, scope: string): string {
  return `${OFFLINE_CACHE_PREFIX}${scope}:${path}`;
}

function writeOfflineCache(key: string, data: unknown): void {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return;
    const serialized = JSON.stringify({ ts: Date.now(), data });
    if (serialized.length > 512_000) return;
    try {
      window.localStorage.setItem(key, serialized);
    } catch {
      // Prune cached API entries if storage quota is full and retry once
      clearOfflineCache();
      window.localStorage.setItem(key, serialized);
    }
  } catch {
    // Ignore storage quota / iframe restrictions
  }
}

function readOfflineCache<T>(key: string): T | null {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return null;
    const raw = window.localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { data?: T };
    return parsed && 'data' in parsed ? (parsed.data as T) : null;
  } catch {
    return null;
  }
}

async function resolveFreshBearerToken(): Promise<string | null> {
  const token = getAuthToken();
  if (token && (token.startsWith('sbit.') || token.startsWith('sbist.'))) {
    return token;
  }
  if (auth.currentUser) {
    try {
      const fresh = await auth.currentUser.getIdToken(false);
      if (fresh) {
        if (fresh !== token) {
          setAuthToken(fresh);
        }
        return fresh;
      }
    } catch {
      // Fallback to stored token
    }
  }
  return token;
}

export async function apiFetch<T = unknown>(
  path: string,
  options: RequestInit & { skipAuth?: boolean } = {}
): Promise<T> {
  const { skipAuth, ...fetchOptions } = options;
  const method = (fetchOptions.method || 'GET').toUpperCase();
  const headers = new Headers(fetchOptions.headers || {});
  if (!headers.has('Content-Type') && fetchOptions.body && !(fetchOptions.body instanceof FormData)) {
    headers.set('Content-Type', 'application/json');
  }
  let resolvedToken: string | null = null;
  if (!skipAuth && !headers.has('Authorization')) {
    resolvedToken = await resolveFreshBearerToken();
    if (resolvedToken) {
      headers.set('Authorization', `Bearer ${resolvedToken}`);
    }
  } else if (!skipAuth) {
    resolvedToken = getAuthToken();
  }

  const cacheKey =
    method === 'GET' ? buildOfflineCacheKey(path, skipAuth ? 'public' : getUserCacheScope(resolvedToken)) : null;

  let res: Response;
  try {
    res = await fetch(path, {
      ...fetchOptions,
      headers,
    });
  } catch (networkErr) {
    if (cacheKey) {
      const cached = readOfflineCache<T>(cacheKey);
      if (cached !== null) {
        return cached;
      }
    }
    throw networkErr;
  }

  const contentType = res.headers.get('content-type') || '';
  if (!res.ok) {
    let message = `Request failed (${res.status})`;
    let code: string | undefined;
    let details: Record<string, unknown> | undefined;
    if (contentType.includes('application/json')) {
      const errData = await res.json().catch(() => ({}));
      if (errData.error) message = errData.error;
      if (errData.code) code = errData.code;
      details = errData;
    }
    throw new ApiError(message, res.status, code, details);
  }

  if (contentType.includes('application/json')) {
    const jsonData = (await res.json()) as T;
    if (cacheKey) {
      writeOfflineCache(cacheKey, jsonData);
    }
    return jsonData;
  }
  return (await res.text()) as unknown as T;
}

export async function downloadAuthenticatedBlob(path: string, filename: string): Promise<void> {
  const headers = new Headers();
  const token = await resolveFreshBearerToken();
  if (token) {
    headers.set('Authorization', `Bearer ${token}`);
  }
  const res = await fetch(path, { headers });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Export failed' }));
    throw new Error(err.error || 'Failed to download file');
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}
