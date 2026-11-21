import { initializeApp, deleteApp, type FirebaseApp } from 'firebase/app';
import {
  initializeAuth,
  inMemoryPersistence,
  signInWithEmailAndPassword,
  type Auth,
} from 'firebase/auth';
import {
  initializeFirestore,
  memoryLocalCache,
  doc,
  onSnapshot,
  setDoc,
  disableNetwork,
  enableNetwork,
  terminate,
  type Firestore,
  type Unsubscribe,
} from 'firebase/firestore';
import type {
  FirebaseWebConfig,
  SignalDocument,
  SignalEntry,
} from '../types';
import { generateUuid } from '../utils/concurrency';

/**
 * Firebase Firestore real-time signal bus (`sync_signals/{vaultId}`).
 *
 * Mobile & Spark Free Tier Safeguards:
 * - Uses `initializeAuth(app, { persistence: inMemoryPersistence })` -> zero WKWebView IndexedDB hangs.
 * - Uses `initializeFirestore(app, { localCache: memoryLocalCache(), experimentalAutoDetectLongPolling: true })`.
 * - Unique FirebaseApp name per instance + `terminate(db)` + `deleteApp(app)` in `disconnect()` -> zero reload collisions.
 * - Rolling ring buffer of last 10 `SignalEntry` records (`{ seq, id, path, md5, parentMd5, trashed, isFolder }`).
 * - Batches/throttles writes to <= 1 write/sec (and sets `requiresDeltaSync: true` for bursts > 10 files).
 * - Exposes `reconnectNetwork()` (`disableNetwork` -> `enableNetwork`) to tear down zombie iOS sockets on >15s resume.
 */

export const SIGNAL_RING_BUFFER_SIZE = 10;
export const SIGNAL_MIN_WRITE_INTERVAL_MS = 1000;

export type OutgoingSignalItem = Omit<SignalEntry, 'seq'>;

export interface PublishSignalOptions {
  requiresDeltaSync?: boolean;
  immediate?: boolean;
}

export interface ISignalBus {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  reconnectNetwork(): Promise<void>;
  publishChanges(items: OutgoingSignalItem[], options?: PublishSignalOptions): Promise<void>;
  flushPendingSignals(): Promise<void>;
  subscribe(handler: (doc: SignalDocument) => void): () => void;
  isConnected(): boolean;
}

/**
 * Pure, testable signal batcher enforcing <= 1 write/sec and rolling 10-item ring buffer.
 */
export class SignalBatcher {
  private seq: number;
  private ringBuffer: SignalEntry[] = [];
  private queuedItems: OutgoingSignalItem[] = [];
  private queuedRequiresDeltaSync = false;
  private lastWriteAt = 0;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private inFlightFlush: Promise<void> | null = null;

  constructor(
    private readonly deviceId: string,
    private readonly writeDoc: (doc: SignalDocument) => Promise<void>,
    private readonly options: {
      minIntervalMs?: number;
      ringBufferSize?: number;
      initialSeq?: number;
      now?: () => number;
    } = {}
  ) {
    // Seed with monotonic HLC floor so cold boots never reset `seq` to 1
    this.seq = Math.max(options.initialSeq ?? 0, this.now());
  }

  private get minIntervalMs(): number {
    return this.options.minIntervalMs ?? SIGNAL_MIN_WRITE_INTERVAL_MS;
  }

  private get ringBufferSize(): number {
    return this.options.ringBufferSize ?? SIGNAL_RING_BUFFER_SIZE;
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  private nextMonotonicSeq(): number {
    this.seq = Math.max(this.seq + 1, this.now());
    return this.seq;
  }

  /**
   * Synchronizes our local sequence counter and ring buffer with observed remote docs.
   */
  observeRemoteDocument(remoteDoc: SignalDocument): void {
    if (remoteDoc.seq > this.seq) {
      this.seq = remoteDoc.seq;
    }
    if (Array.isArray(remoteDoc.entries) && remoteDoc.entries.length > 0) {
      // Keep the latest entries from the shared document so our ring buffer retains history
      const merged = [...this.ringBuffer, ...remoteDoc.entries];
      const dedupBySeq = new Map<number, SignalEntry>();
      for (const e of merged) {
        dedupBySeq.set(e.seq, e);
      }
      this.ringBuffer = Array.from(dedupBySeq.values())
        .sort((a, b) => a.seq - b.seq)
        .slice(-this.ringBufferSize);
    }
  }

  enqueue(items: OutgoingSignalItem[], options: PublishSignalOptions = {}): Promise<void> {
    if (items.length === 0 && !options.requiresDeltaSync) {
      return Promise.resolve();
    }

    this.queuedItems.push(...items);
    if (options.requiresDeltaSync || this.queuedItems.length > this.ringBufferSize) {
      this.queuedRequiresDeltaSync = true;
    }

    const elapsed = this.now() - this.lastWriteAt;
    if (
      (options.immediate && elapsed >= this.minIntervalMs) ||
      this.lastWriteAt === 0 ||
      elapsed >= this.minIntervalMs
    ) {
      return this.flush();
    }

    if (!this.flushTimer) {
      const waitMs = Math.max(0, this.minIntervalMs - elapsed);
      this.flushTimer = setTimeout(() => {
        this.flushTimer = null;
        void this.flush();
      }, waitMs);
    }

    return Promise.resolve();
  }

  async flush(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }

    if (this.inFlightFlush) {
      await this.inFlightFlush;
      if (this.queuedItems.length === 0 && !this.queuedRequiresDeltaSync) {
        return;
      }
    }

    if (this.queuedItems.length === 0 && !this.queuedRequiresDeltaSync) {
      return;
    }

    const batch = this.queuedItems.splice(0, this.queuedItems.length);
    const requiresDeltaSync =
      this.queuedRequiresDeltaSync || batch.length > this.ringBufferSize;
    this.queuedRequiresDeltaSync = false;

    // Assign monotonic HLC sequence numbers; keep only the last `ringBufferSize` entries
    const sliced = batch.slice(-this.ringBufferSize);
    for (const item of sliced) {
      const entrySeq = this.nextMonotonicSeq();
      const entry: SignalEntry = {
        seq: entrySeq,
        id: item.id,
        path: item.path,
      };
      if (item.md5 !== undefined) entry.md5 = item.md5;
      if (item.parentMd5 !== undefined) entry.parentMd5 = item.parentMd5;
      if (item.trashed !== undefined) entry.trashed = item.trashed;
      if (item.isFolder !== undefined) entry.isFolder = item.isFolder;
      if (item.oldPath !== undefined) entry.oldPath = item.oldPath;
      this.ringBuffer.push(entry);
    }
    if (sliced.length === 0) {
      this.nextMonotonicSeq();
    }

    if (this.ringBuffer.length > this.ringBufferSize) {
      this.ringBuffer = this.ringBuffer.slice(-this.ringBufferSize);
    }

    const payload: SignalDocument = {
      seq: this.seq,
      pulseId: generateUuid(),
      sender: this.deviceId,
      updatedAt: this.now(),
      requiresDeltaSync,
      entries: [...this.ringBuffer],
    };

    this.lastWriteAt = this.now();
    this.inFlightFlush = this.writeDoc(payload).finally(() => {
      this.inFlightFlush = null;
    });

    await this.inFlightFlush;
  }

  dispose(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.queuedItems.length = 0;
    this.queuedRequiresDeltaSync = false;
  }
}

export interface FirestoreSignalBusOptions {
  firebaseConfig: FirebaseWebConfig;
  email: string;
  password: string;
  vaultId: string;
  deviceId: string;
  forceLongPolling?: boolean;
  initialLastSeenSeq?: number;
  initialLastSeenPulseId?: string;
  onLog?: (level: 'info' | 'warn' | 'error', message: string) => void;
}

export class FirestoreSignalBus implements ISignalBus {
  private readonly options: FirestoreSignalBusOptions;
  private readonly listeners = new Set<(doc: SignalDocument) => void>();
  private app: FirebaseApp | null = null;
  private auth: Auth | null = null;
  private db: Firestore | null = null;
  private unsubscribeSnapshot: Unsubscribe | null = null;
  private batcher: SignalBatcher;
  private connected = false;
  private lastSeenSeq: number;
  private lastSeenPulseId?: string;
  private initializedSnapshot = false;

  constructor(options: FirestoreSignalBusOptions) {
    this.options = options;
    this.lastSeenSeq = options.initialLastSeenSeq ?? 0;
    this.lastSeenPulseId = options.initialLastSeenPulseId;
    this.batcher = new SignalBatcher(
      options.deviceId,
      (signalDoc) => this.writeSignalDocument(signalDoc),
      { initialSeq: this.lastSeenSeq }
    );
  }

  isConnected(): boolean {
    return this.connected;
  }

  subscribe(handler: (doc: SignalDocument) => void): () => void {
    this.listeners.add(handler);
    return () => {
      this.listeners.delete(handler);
    };
  }

  async connect(): Promise<void> {
    if (this.connected) return;
    const { firebaseConfig, email, password, vaultId, forceLongPolling } = this.options;
    if (!firebaseConfig || !firebaseConfig.apiKey || !firebaseConfig.projectId) {
      throw new Error('Firebase configuration is incomplete');
    }
    if (!email || !password) {
      throw new Error('Firebase email and password are required');
    }

    // Unique app name avoids `app/duplicate-app` and `firestore/already-initialized` across plugin reloads
    const appName = `trisync-${vaultId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const app = initializeApp(firebaseConfig, appName);
    this.app = app;

    try {
      // Strictly in-memory persistence avoids iOS WKWebView IndexedDB deadlocks!
      const auth = initializeAuth(app, {
        persistence: inMemoryPersistence,
      });
      this.auth = auth;

      await signInWithEmailAndPassword(auth, email, password);

      const db = initializeFirestore(app, {
        localCache: memoryLocalCache(),
        ...(forceLongPolling
          ? { experimentalForceLongPolling: true }
          : { experimentalAutoDetectLongPolling: true }),
      });
      this.db = db;
      this.initializedSnapshot = false;

      const docRef = doc(db, 'sync_signals', vaultId);
      this.unsubscribeSnapshot = onSnapshot(
        docRef,
        (snapshot) => {
          // Ignore local cache echoes
          if (snapshot.metadata.fromCache) return;
          if (!snapshot.exists()) {
            this.initializedSnapshot = true;
            return;
          }

          const raw = snapshot.data() as Partial<SignalDocument>;
          if (typeof raw.seq !== 'number' || typeof raw.sender !== 'string') {
            return;
          }

          const signalDoc: SignalDocument = {
            seq: raw.seq,
            pulseId: typeof raw.pulseId === 'string' ? raw.pulseId : undefined,
            sender: raw.sender,
            updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : Date.now(),
            requiresDeltaSync: Boolean(raw.requiresDeltaSync),
            entries: Array.isArray(raw.entries) ? (raw.entries as SignalEntry[]) : [],
          };

          this.batcher.observeRemoteDocument(signalDoc);

          // Ignore initial boot snapshot if already seen (by pulseId, or seq fallback for legacy docs)
          if (!this.initializedSnapshot) {
            this.initializedSnapshot = true;
            if (
              (signalDoc.pulseId && signalDoc.pulseId === this.lastSeenPulseId) ||
              (!signalDoc.pulseId && signalDoc.seq <= this.lastSeenSeq)
            ) {
              return;
            }
          }

          // Ignore our own echoes
          if (signalDoc.sender === this.options.deviceId) {
            if (signalDoc.pulseId) this.lastSeenPulseId = signalDoc.pulseId;
            if (signalDoc.seq > this.lastSeenSeq) this.lastSeenSeq = signalDoc.seq;
            return;
          }

          // On live snapshots from peers, deduplicate strictly by pulseId so concurrent
          // pulses with colliding/lower HLC seq are NEVER dropped!
          if (signalDoc.pulseId) {
            if (signalDoc.pulseId === this.lastSeenPulseId) {
              return;
            }
            this.lastSeenPulseId = signalDoc.pulseId;
          } else if (signalDoc.seq <= this.lastSeenSeq) {
            return;
          }

          if (signalDoc.seq > this.lastSeenSeq) {
            this.lastSeenSeq = signalDoc.seq;
          }

          for (const listener of this.listeners) {
            try {
              listener(signalDoc);
            } catch (err) {
              this.options.onLog?.('error', `Signal listener error: ${String(err)}`);
            }
          }
        },
        (error) => {
          this.options.onLog?.('warn', `Firestore onSnapshot error: ${error.message}`);
        }
      );

      this.connected = true;
    } catch (err) {
      await this.disconnect();
      throw err;
    }
  }

  private async writeSignalDocument(signalDoc: SignalDocument): Promise<void> {
    if (!this.db || !this.connected) return;
    try {
      const docRef = doc(this.db, 'sync_signals', this.options.vaultId);
      await setDoc(docRef, signalDoc);
      if (signalDoc.pulseId) {
        this.lastSeenPulseId = signalDoc.pulseId;
      }
      if (signalDoc.seq > this.lastSeenSeq) {
        this.lastSeenSeq = signalDoc.seq;
      }
    } catch (err) {
      this.options.onLog?.('warn', `Firestore signal write failed (Drive fallback active): ${String(err)}`);
    }
  }

  async publishChanges(
    items: OutgoingSignalItem[],
    options: PublishSignalOptions = {}
  ): Promise<void> {
    if (!this.connected) return;
    await this.batcher.enqueue(items, options);
  }

  async flushPendingSignals(): Promise<void> {
    if (!this.connected) return;
    await this.batcher.flush();
  }

  /**
   * Tears down zombie half-open TCP sockets after mobile backgrounding >15s (P1 #4).
   */
  async reconnectNetwork(): Promise<void> {
    if (!this.db || !this.connected) return;
    try {
      await disableNetwork(this.db);
      await enableNetwork(this.db);
    } catch (err) {
      this.options.onLog?.('warn', `Firestore reconnectNetwork warning: ${String(err)}`);
    }
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    this.batcher.dispose();

    if (this.unsubscribeSnapshot) {
      try {
        this.unsubscribeSnapshot();
      } catch {
        // ignore
      }
      this.unsubscribeSnapshot = null;
    }

    if (this.db) {
      try {
        await terminate(this.db);
      } catch {
        // ignore
      }
      this.db = null;
    }

    this.auth = null;

    if (this.app) {
      try {
        await deleteApp(this.app);
      } catch {
        // ignore
      }
      this.app = null;
    }
  }
}
