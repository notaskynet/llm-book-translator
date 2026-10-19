import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { DexieCheckpointStore } from '../src/checkpoint/db';
import { TxtAdapter } from '../src/formats/txt';
import { encodeUtf8 } from '../src/formats/types';
import { translateJob } from '../src/translate/generic';
import { fakeProvider, sourceOf, tagged } from './helpers';

let n = 0;
let store: DexieCheckpointStore;
beforeEach(() => {
  store = new DexieCheckpointStore(`test-db-${n++}`);
});

const job = (id = 'j1') => ({
  id, fileName: 'a.txt', fileType: 'txt', config: { targetLanguage: 'French' },
  input: encodeUtf8('hello').buffer as ArrayBuffer, totalChunks: 2,
});

describe('DexieCheckpointStore', () => {
  it('returns null for an unknown job', async () => {
    expect(await store.loadCheckpoint('nope')).toBeNull();
  });

  it('stores chunks with the right status and returns them in order', async () => {
    await store.startJob(job());
    await store.saveCheckpoint({ jobId: 'j1', chunkIndex: 1, originalText: 'b', translatedText: 'B', chunkData: { chunk_index: 1 }, totalChunks: 2 });
    await store.saveCheckpoint({ jobId: 'j1', chunkIndex: 0, originalText: 'a', translatedText: null, chunkData: { chunk_index: 0 }, totalChunks: 2 });

    const cp = await store.loadCheckpoint('j1');
    expect(cp!.chunks.map((c) => [c.chunkIndex, c.status, c.translatedText])).toEqual([[0, 'failed', null], [1, 'completed', 'B']]);

    // A retry overwrites the failed record instead of duplicating it.
    await store.saveCheckpoint({ jobId: 'j1', chunkIndex: 0, originalText: 'a', translatedText: 'A', chunkData: {}, totalChunks: 2 });
    expect((await store.loadCheckpoint('j1'))!.chunks.map((c) => c.status)).toEqual(['completed', 'completed']);
  });

  it('lists resumable jobs, newest first, and excludes completed ones', async () => {
    await store.startJob(job('old'));
    await new Promise((r) => setTimeout(r, 5));
    await store.startJob(job('new'));
    await store.startJob(job('done'));
    await store.markPaused('new');
    await store.markCompleted('done');
    expect((await store.listResumable()).map((j) => j.id)).toEqual(['new', 'old']);
  });

  it('drops the input and chunks of a completed job', async () => {
    await store.startJob(job());
    await store.saveCheckpoint({ jobId: 'j1', chunkIndex: 0, originalText: 'a', translatedText: 'A', chunkData: {}, totalChunks: 2 });
    await store.markCompleted('j1');
    expect((await store.getJob('j1'))!.input.byteLength).toBe(0);
    expect((await store.loadCheckpoint('j1'))!.chunks).toEqual([]);
  });

  it('never persists anything that looks like a key', async () => {
    await store.startJob({ ...job(), config: { model: 'm', baseUrl: 'https://x/v1' } });
    expect(JSON.stringify(await store.getJob('j1'))).not.toMatch(/api[_-]?key/i);
  });

  it('deletes jobs and expires old ones', async () => {
    await store.startJob(job('a'));
    await store.saveCheckpoint({ jobId: 'a', chunkIndex: 0, originalText: 'a', translatedText: 'A', chunkData: {}, totalChunks: 1 });
    await store.deleteJob('a');
    expect(await store.getJob('a')).toBeUndefined();
    expect(await store.db.chunks.count()).toBe(0);

    await store.startJob(job('b'));
    await new Promise((r) => setTimeout(r, 5));
    await store.deleteExpired(1);
    expect(await store.getJob('b')).toBeUndefined();
  });

  it('resumes a real translation after a simulated reload', async () => {
    const sentence = 'The traveller walked slowly along the old road. ';
    const text = Array.from({ length: 12 }, (_, i) => `Paragraph ${i}. ${sentence.repeat(8)}`).join('\n\n');
    const input = encodeUtf8(text);
    const run = (provider: ReturnType<typeof fakeProvider>, store: DexieCheckpointStore, extra = {}) =>
      translateJob({
        adapter: new TxtAdapter(input, { maxTokensPerChunk: 300 }), store, translationId: 'real', fileName: 'b.txt',
        input: input.buffer as ArrayBuffer, sourceLanguage: 'English', targetLanguage: 'French', provider, ...extra,
      });

    let stop = false;
    const first = fakeProvider((u) => (stop = true, tagged(`FR ${sourceOf(u)}`)));
    expect((await run(first, store, { callbacks: { shouldInterrupt: () => stop } })).status).toBe('paused');

    // A brand-new store instance on the same database stands in for a page reload.
    const reopened = new DexieCheckpointStore(store.db.name);
    const [resumable] = await reopened.listResumable();
    expect(resumable.id).toBe('real');

    const second = fakeProvider((u) => tagged(`FR ${sourceOf(u)}`));
    const out = await run(second, reopened);
    expect(out.status).toBe('completed');
    expect(second.calls.length).toBeGreaterThan(0);
    expect(first.calls.length + second.calls.length).toBe(4);
  });
});
