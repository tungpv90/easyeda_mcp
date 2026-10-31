import { checkpointStore, type Checkpoint, type CheckpointListOptions } from './checkpoint-store';
import "@copilot/shared/types/eda";

// Persistent sources stay in IndexedDB. Only a temporary checkpoint retains content.
let lastCheckpoint: { id: string; temporary?: Checkpoint } | undefined;
const pinned = new Map<string, number>();
let saveTail = Promise.resolve();
let pendingSaves = 0;
let restoring = false;

const getCurrentPageId = async () => {
    const page = await eda.dmt_SelectControl.getCurrentDocumentInfo();
    if (typeof page?.uuid !== 'string' || !page.uuid) throw new Error('Current document UUID is unavailable');
    return page.uuid;
}

function saveCheckpoint(minor: boolean, name?: string): Promise<string | null> {
    // Capture sources only once a save reaches the front. Bound waiting requests too.
    if (pendingSaves >= 8) {
        eda.sys_Message.showToastMessage('Too many pending checkpoint saves; wait and retry.', ESYS_ToastMessageType.ERROR);
        return Promise.resolve(null);
    }
    pendingSaves++;
    const operation = saveTail.then(() => createCheckpoint(minor, name));
    saveTail = operation.then(() => undefined, () => undefined);
    return operation.finally(() => { pendingSaves--; });
}

async function createCheckpoint(minor: boolean, name?: string) {
    try {
        if (name !== undefined && (typeof name !== 'string' || name.trim().length > 200)) {
            throw new Error('Checkpoint name must be a string of at most 200 characters');
        }
        const pageId = await getCurrentPageId();
        const content = await eda.sys_FileManager.getDocumentSource();
        if (typeof content !== 'string' || !content) {
            eda.sys_Message.showToastMessage('Failed insert checkpoint to db: not found content', ESYS_ToastMessageType.WARNING);
            return null;
        }

        const checkpoint: Checkpoint = {
            _id: crypto.randomUUID(),
            timestamp: Date.now(),
            content,
            ...(name?.trim() ? { name: name.trim() } : {}),
            pageId
        };

        if (await getCurrentPageId() !== pageId) {
            throw new Error('Current document changed while creating checkpoint');
        }

        if (!minor) {
            for (const [id, expiresAt] of pinned) if (expiresAt <= Date.now()) pinned.delete(id);
            await checkpointStore.add(checkpoint, id => (pinned.get(id) ?? 0) > Date.now());
            eda.sys_Message.showToastMessage('Create checkpoint', ESYS_ToastMessageType.SUCCESS);
        }

        lastCheckpoint = { id: checkpoint._id, ...(minor ? { temporary: checkpoint } : {}) };
        return checkpoint._id;
    } catch (error) {
        eda.sys_Message.showToastMessage('Failed to save checkpoint: ' + (error as Error).message, ESYS_ToastMessageType.ERROR);
        return null;
    }
}

const confirmationMessage = (...args: Parameters<typeof eda.sys_Dialog.showConfirmationMessage>) => {
    return new Promise<boolean>((resolve) => {
        eda.sys_Dialog.showConfirmationMessage(args[0], args[1], args[2], args[3], resolve);
    })
}

async function restoreCheckpoint(id?: string, allAgree = false, signal?: AbortSignal) {
    signal?.throwIfAborted();
    if (restoring) {
        eda.sys_Message.showToastMessage('A checkpoint restore is already in progress.', ESYS_ToastMessageType.ERROR);
        return false;
    }
    restoring = true;
    try { return await applyCheckpoint(id, allAgree, signal); }
    finally { restoring = false; }
}

async function applyCheckpoint(id?: string, allAgree = false, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const previous = lastCheckpoint;
    let checkpoint: Checkpoint | undefined;

    if (!id) {
        checkpoint = previous?.temporary ?? (previous ? await checkpointStore.get(previous.id) : undefined);
    }
    else {
        checkpoint = await checkpointStore.get(id);
    }
    signal?.throwIfAborted();

    if (!checkpoint) {
        eda.sys_Message.showToastMessage('Not found checkpoint to restore', ESYS_ToastMessageType.INFO);
        return false;
    }

    if (!checkpoint.pageId) {
        eda.sys_Message.showToastMessage('This legacy checkpoint has no document UUID and cannot be restored safely.', ESYS_ToastMessageType.ERROR);
        return false;
    }

    if (typeof checkpoint.content !== 'string' || !checkpoint.content) {
        eda.sys_Message.showToastMessage('This checkpoint has no valid document source.', ESYS_ToastMessageType.ERROR);
        return false;
    }

    if (checkpoint.pageId !== await getCurrentPageId()) {
        eda.sys_Message.showToastMessage('This checkpoint was not created for this page.', ESYS_ToastMessageType.ERROR);
        return false;
    }

    if (!allAgree)
        if (!await confirmationMessage('Are you sure you want to restore this checkpoint? Current changes may be lost.', 'Restore'))
            return false;

    signal?.throwIfAborted();

    // The confirmation dialog and UUID lookup both yield to the editor.
    if (checkpoint.pageId !== await getCurrentPageId()) {
        eda.sys_Message.showToastMessage('This checkpoint was not created for this page.', ESYS_ToastMessageType.ERROR);
        return false;
    }
    signal?.throwIfAborted();

    try {
        const success = await eda.sys_FileManager.setDocumentSource(checkpoint.content);
        if (success && lastCheckpoint === previous && previous?.id === checkpoint._id) lastCheckpoint = undefined;
        eda.sys_Message.showToastMessage(success ? 'Loaded checkpoint' : 'Fail load checkpoint', success ? ESYS_ToastMessageType.SUCCESS : ESYS_ToastMessageType.ERROR);
        return success;
    } catch (error) {
        eda.sys_Message.showToastMessage('Failed to restore checkpoint: ' + (error as Error).message, ESYS_ToastMessageType.ERROR);
        return false;
    }
}

async function listCheckpoints(options?: CheckpointListOptions) {
    const currentPageId = await getCurrentPageId();
    const checkpoints = await checkpointStore.listMetadata(options);

    return checkpoints
        .map(checkpoint => ({
            _id: checkpoint._id,
            timestamp: checkpoint.timestamp,
            name: checkpoint.name == null ? `Unnamed — ${new Date(checkpoint.timestamp).toISOString()}` : String(checkpoint.name),
            pageId: checkpoint.pageId,
            isCurrentPage: Boolean(checkpoint.pageId) && checkpoint.pageId === currentPageId,
        }));
}

async function readCheckpoint(id: string) {
    const checkpoint = await checkpointStore.get(id);
    if (!checkpoint) return null;

    return {
        _id: checkpoint._id,
        timestamp: checkpoint.timestamp,
        name: checkpoint.name == null ? undefined : String(checkpoint.name),
        pageId: checkpoint.pageId,
        content: checkpoint.content,
    };
}

export const checkpointer = {
    pin: (id: string, expiresAt: number) => { pinned.set(id, expiresAt); },
    unpin: (id: string) => { pinned.delete(id); },
    restore: restoreCheckpoint,
    save: saveCheckpoint,
    list: listCheckpoints,
    read: readCheckpoint,
    hasCheckpoint: () => !!lastCheckpoint
}
