import { DexieCheckpointStore } from './db';

/** The app-wide checkpoint store (IndexedDB). */
export const checkpointStore = new DexieCheckpointStore();

// Jobs nobody resumed within a month are not coming back.
const JOB_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
void checkpointStore.deleteExpired(JOB_MAX_AGE_MS).catch(() => {});
