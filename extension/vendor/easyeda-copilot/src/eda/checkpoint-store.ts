export interface Checkpoint {
    _id: string;
    timestamp: number;
    content: string;
    name?: string;
    pageId?: string;
}

export type CheckpointMetadata = Omit<Checkpoint, 'content'>;
export type CheckpointListOptions = { limit?: number; offset?: number };

const DATABASE = 'checkpoints';
const STORE = 'checkpoints';
const TIME_INDEX = 'timestamp';

function hasTimeIndex(store: IDBObjectStore) {
    if (store.indexNames.length !== 1 || !store.indexNames.contains(TIME_INDEX)) return false;
    const index = store.index(TIME_INDEX);
    return index.keyPath === 'timestamp' && !index.unique && !index.multiEntry;
}

// Keep AppDB's existing store and primary key. No document is rewritten during upgrade.
function openDatabase(version?: number): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
        const request = globalThis.indexedDB.open(DATABASE, version);
        let settled = false;
        let upgradeError: unknown;
        request.onblocked = () => {
            settled = true;
            reject(new Error('Checkpoint database upgrade is blocked by another open connection. Close other editor windows and retry.'));
        };
        request.onupgradeneeded = () => {
            const transaction = request.transaction!;
            if (settled) { transaction.abort(); return; }
            try {
                const store = request.result.objectStoreNames.contains(STORE)
                    ? transaction.objectStore(STORE)
                    : request.result.createObjectStore(STORE, { keyPath: '_id', autoIncrement: true });
                if (store.keyPath !== '_id') throw new Error('Unsupported checkpoint database primary key');
                // In particular, never retain the old multi-megabyte content index.
                for (const index of Array.from(store.indexNames)) store.deleteIndex(index);
                store.createIndex(TIME_INDEX, 'timestamp');
            } catch (error) {
                upgradeError = error;
                transaction.abort();
            }
        };
        request.onerror = () => { settled = true; reject(upgradeError ?? request.error); };
        request.onsuccess = () => {
            const database = request.result;
            if (settled) { database.close(); return; }
            settled = true;
            database.onversionchange = () => database.close();
            resolve(database);
        };
    });
}

async function openStore(): Promise<IDBDatabase> {
    // A second renderer may upgrade the database between inspection and open(version).
    for (let attempt = 0; attempt < 3; attempt++) {
        const database = await openDatabase();
        let upgrade: boolean;
        try {
            upgrade = !database.objectStoreNames.contains(STORE);
            if (!upgrade) {
                const store = database.transaction(STORE).objectStore(STORE);
                if (store.keyPath !== '_id') throw new Error('Unsupported checkpoint database primary key');
                upgrade = !hasTimeIndex(store);
            }
        } catch (error) {
            database.close();
            throw error;
        }
        if (!upgrade) return database;
        const version = database.version + 1;
        database.close();
        try { return await openDatabase(version); }
        catch (error) {
            if ((error as { name?: string })?.name !== 'VersionError') throw error;
        }
    }
    throw new Error('Checkpoint database version kept changing; retry the operation');
}

type Guard = (callback: () => void) => () => void;

async function transact<T>(mode: IDBTransactionMode,
    run: (store: IDBObjectStore, result: (value: T) => void, guard: Guard) => void): Promise<T> {
    const database = await openStore();
    try {
        return await new Promise<T>((resolve, reject) => {
            const transaction = database.transaction(STORE, mode);
            let result: T;
            let failure: unknown;
            const guard: Guard = callback => () => {
                try { callback(); }
                catch (error) {
                    failure = error;
                    transaction.abort();
                }
            };
            transaction.oncomplete = () => resolve(result);
            transaction.onabort = () => reject(failure ?? transaction.error ?? new Error('Checkpoint transaction aborted'));
            guard(() => run(transaction.objectStore(STORE), value => { result = value; }, guard))();
        });
    } finally { database.close(); }
}

function readMetadataPage(store: IDBObjectStore, limit: number, offset: number,
    guard: Guard, done: (rows: CheckpointMetadata[]) => void) {
    const rows: CheckpointMetadata[] = [];
    const request = store.index(TIME_INDEX).openKeyCursor(null, 'prev');
    request.onsuccess = guard(() => {
        const cursor = request.result;
        if (!cursor) { done(rows); return; }
        // Skip keys before loading any full values, including the first offset row.
        if (offset) {
            // advance() takes an unsigned 32-bit count, while offset is a safe integer.
            const skip = Math.min(offset, 0xffffffff);
            offset -= skip;
            cursor.advance(skip);
            return;
        }
        const record = store.get(cursor.primaryKey);
        record.onsuccess = guard(() => {
            const { _id, timestamp, name, pageId } = record.result as Checkpoint;
            rows.push({ _id, timestamp, name, pageId });
            if (rows.length === limit) { done(rows); return; }
            cursor.continue();
        });
    });
}

function pruneAndAdd(store: IDBObjectStore, checkpoint: Checkpoint, isPinned: (id: string) => boolean, guard: Guard) {
    const request = store.index(TIME_INDEX).openKeyCursor(null, 'prev');
    let skipNewest = true;
    request.onsuccess = guard(() => {
        const cursor = request.result;
        if (!cursor) { store.add(checkpoint); return; }
        if (skipNewest) { skipNewest = false; cursor.advance(99); return; }
        if (!isPinned(cursor.primaryKey as string)) store.delete(cursor.primaryKey);
        cursor.continue();
    });
}

export const checkpointStore = {
    count: () => transact<number>('readonly', (store, result, guard) => {
        const request = store.count();
        request.onsuccess = guard(() => result(request.result));
    }),
    get: (id: string) => transact<Checkpoint | undefined>('readonly', (store, result, guard) => {
        const request = store.get(id);
        request.onsuccess = guard(() => result(request.result as Checkpoint | undefined));
    }),
    listMetadata: async ({ limit = 16, offset = 0 }: CheckpointListOptions = {}) => {
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 512) throw new Error('Checkpoint limit must be an integer between 1 and 512');
        if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('Checkpoint offset must be a non-negative safe integer');
        return transact<CheckpointMetadata[]>('readonly', (store, result, guard) => {
            readMetadataPage(store, limit, offset, guard, result);
        });
    },
    add: (checkpoint: Checkpoint, isPinned: (id: string) => boolean) => transact<void>('readwrite', (store, _result, guard) => {
        const count = store.count();
        count.onsuccess = guard(() => {
            if (count.result < 512) { store.add(checkpoint); return; }
            // Detect a collision before pruning could delete the conflicting record.
            const existing = store.getKey(checkpoint._id);
            existing.onsuccess = guard(() => {
                if (existing.result !== undefined) throw new Error('Checkpoint ID already exists');
                // Keys alone identify old snapshots. A failed insert rolls back pruning too.
                pruneAndAdd(store, checkpoint, isPinned, guard);
            });
        });
    }),
    delete: (id: string) => transact<void>('readwrite', store => { store.delete(id); }),
};
