/**
 * Concurrency primitives: bounded TaskPool, deadlock-free KeyedMutex,
 * exponential backoff with jitter (`withRetry`), and flushable `KeyedDebouncer`.
 */

export class TaskPool {
  private active = 0;
  private queue: Array<() => void> = [];

  constructor(private readonly concurrency: number = 6) {
    if (concurrency < 1) {
      throw new Error('TaskPool concurrency must be >= 1');
    }
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.concurrency) {
      await new Promise<void>((resolve) => {
        this.queue.push(resolve);
      });
    }
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      const next = this.queue.shift();
      if (next) next();
    }
  }

  async runAll<T, R>(items: readonly T[], fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
    return Promise.all(items.map((item, idx) => this.run(() => fn(item, idx))));
  }
}

/**
 * Serializes async operations per key (or sorted set of keys to prevent deadlocks).
 */
export class KeyedMutex {
  private readonly tails = new Map<string, Promise<void>>();

  async runExclusive<T>(keys: string | string[], fn: () => Promise<T>): Promise<T> {
    const uniqueSorted = Array.isArray(keys)
      ? Array.from(new Set(keys)).sort()
      : [keys];

    if (uniqueSorted.length === 0) {
      return fn();
    }

    const acquireNext = async (idx: number): Promise<T> => {
      if (idx >= uniqueSorted.length) {
        return fn();
      }
      const key = uniqueSorted[idx];
      const prev = this.tails.get(key) ?? Promise.resolve();
      let release!: () => void;
      const current = new Promise<void>((resolve) => {
        release = resolve;
      });
      const tail = prev.then(() => current);
      this.tails.set(key, tail);

      await prev;
      try {
        return await acquireNext(idx + 1);
      } finally {
        release();
        if (this.tails.get(key) === tail) {
          this.tails.delete(key);
        }
      }
    };

    return acquireNext(0);
  }
}

export interface RetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  shouldRetry?: (err: unknown, attempt: number) => boolean;
  sleep?: (ms: number) => Promise<void>;
}

export interface RetryableErrorShape {
  status?: number;
  retryAfterMs?: number;
  code?: string;
  message?: string;
  nonRetryable?: boolean;
}

export function defaultShouldRetry(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as RetryableErrorShape;
  if (e.nonRetryable) return false;

  if (typeof e.status === 'number') {
    if (e.status === 429) return true;
    if (e.status >= 500 && e.status < 600) return true;
    if (e.status === 403) {
      const msg = (e.message ?? '').toLowerCase();
      return (
        msg.includes('ratelimit') ||
        msg.includes('rate limit') ||
        msg.includes('userratelimitexceeded') ||
        msg.includes('quota')
      );
    }
    return false;
  }

  // Transient network / fetch / timeout failures without HTTP status
  const msg = (e.message ?? '').toLowerCase();
  return (
    msg.includes('network') ||
    msg.includes('timeout') ||
    msg.includes('econnreset') ||
    msg.includes('enotfound') ||
    msg.includes('fetch') ||
    msg.includes('socket') ||
    msg.includes('offline')
  );
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const maxAttempts = options.maxAttempts ?? 4;
  const baseDelayMs = options.baseDelayMs ?? 250;
  const maxDelayMs = options.maxDelayMs ?? 10_000;
  const shouldRetry = options.shouldRetry ?? defaultShouldRetry;
  const sleep = options.sleep ?? defaultSleep;

  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt >= maxAttempts || !shouldRetry(err, attempt)) {
        throw err;
      }

      const retryAfter =
        err && typeof err === 'object' && typeof (err as RetryableErrorShape).retryAfterMs === 'number'
          ? (err as RetryableErrorShape).retryAfterMs!
          : null;

      const exp = Math.min(maxDelayMs, baseDelayMs * Math.pow(2, attempt - 1));
      const jittered = Math.floor(exp * (0.5 + Math.random() * 0.5));
      const delayMs = retryAfter !== null ? Math.min(maxDelayMs, Math.max(0, retryAfter)) : jittered;
      await sleep(delayMs);
    }
  }
  throw lastError;
}

interface PendingDebouncedEntry {
  timer: ReturnType<typeof setTimeout>;
  fn: () => Promise<void> | void;
}

/**
 * Per-key debouncer supporting immediate `flush(key)` and `flushAll()`
 * (critical for flushing edits before iOS/Android WKWebView suspension).
 */
export class KeyedDebouncer {
  private readonly pending = new Map<string, PendingDebouncedEntry>();
  private readonly inflight = new Set<Promise<void>>();

  constructor(private defaultDelayMs: number = 800) {}

  setDefaultDelay(delayMs: number): void {
    this.defaultDelayMs = Math.max(0, delayMs);
  }

  schedule(key: string, fn: () => Promise<void> | void, delayMs?: number): void {
    const existing = this.pending.get(key);
    if (existing) {
      clearTimeout(existing.timer);
    }

    const wait = delayMs ?? this.defaultDelayMs;
    if (wait <= 0) {
      this.pending.delete(key);
      this.invoke(fn);
      return;
    }

    const timer = setTimeout(() => {
      this.pending.delete(key);
      this.invoke(fn);
    }, wait);

    this.pending.set(key, { timer, fn });
  }

  cancel(key: string): void {
    const existing = this.pending.get(key);
    if (existing) {
      clearTimeout(existing.timer);
      this.pending.delete(key);
    }
  }

  async flush(key: string): Promise<void> {
    const existing = this.pending.get(key);
    if (!existing) return;
    clearTimeout(existing.timer);
    this.pending.delete(key);
    await this.invoke(existing.fn);
  }

  async flushAll(): Promise<void> {
    const entries = Array.from(this.pending.entries());
    this.pending.clear();
    const promises: Promise<void>[] = [];
    for (const [, entry] of entries) {
      clearTimeout(entry.timer);
      promises.push(this.invoke(entry.fn));
    }
    await Promise.all([...promises, ...Array.from(this.inflight)]);
  }

  clear(): void {
    for (const [, entry] of this.pending.entries()) {
      clearTimeout(entry.timer);
    }
    this.pending.clear();
  }

  size(): number {
    return this.pending.size;
  }

  private invoke(fn: () => Promise<void> | void): Promise<void> {
    const p = Promise.resolve()
      .then(() => fn())
      .catch(() => {
        // Callers handle their own errors; prevent unhandled rejections during flush.
      });
    this.inflight.add(p);
    p.finally(() => this.inflight.delete(p));
    return p;
  }
}

export function generateUuid(): string {
  if (typeof globalThis.crypto !== 'undefined' && typeof globalThis.crypto.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }
  const bytes = new Uint8Array(16);
  if (typeof globalThis.crypto !== 'undefined' && typeof globalThis.crypto.getRandomValues === 'function') {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < 16; i++) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
