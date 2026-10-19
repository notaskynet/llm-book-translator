import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { DexieCheckpointStore } from '../src/checkpoint/db';
import { currentOptions } from '../src/store/translation';

describe('currentOptions', () => {
  it('contains plain data only, so it can be stored with a job', async () => {
    const options = currentOptions();
    expect(Object.values(options).some((v) => typeof v === 'function')).toBe(false);

    // IndexedDB rejects anything that cannot be structured-cloned (e.g. store actions).
    const store = new DexieCheckpointStore('options-test');
    await expect(
      store.startJob({ id: 'o', fileName: 'a.txt', fileType: 'txt', config: { ...options }, input: new ArrayBuffer(1), totalChunks: 1 }),
    ).resolves.toBeUndefined();
  });
});
