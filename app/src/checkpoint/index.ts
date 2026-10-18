import { LibraryStore } from '../library/store';
import { BookTranslatorDB, DexieCheckpointStore } from './db';

const db = new BookTranslatorDB();

/** The app-wide checkpoint store (IndexedDB). */
export const checkpointStore = new DexieCheckpointStore(db);

/** The user's style presets and glossaries, in the same database. */
export const library = new LibraryStore(db);

// Jobs nobody resumed within a month are not coming back.
const JOB_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
void checkpointStore.deleteExpired(JOB_MAX_AGE_MS).catch(() => {});
