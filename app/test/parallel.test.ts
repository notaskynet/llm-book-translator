import { describe, expect, it } from 'vitest';
import { iterOrderedConcurrent } from '../src/translate/parallel';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('iterOrderedConcurrent', () => {
  it('yields results in input order even when later items finish first', async () => {
    const delays = [30, 5, 15, 1];
    const out: number[] = [];
    for await (const r of iterOrderedConcurrent([0, 1, 2, 3], 4, async (i) => (await sleep(delays[i]), i * 10))) {
      out.push(r.value!);
    }
    expect(out).toEqual([0, 10, 20, 30]);
  });

  it('never exceeds the worker limit and keeps the pool full', async () => {
    let active = 0;
    let peak = 0;
    const items = Array.from({ length: 10 }, (_, i) => i);
    for await (const _ of iterOrderedConcurrent(items, 3, async () => {
      peak = Math.max(peak, ++active);
      await sleep(5);
      active--;
    })) { /* drain */ }
    expect(peak).toBe(3);
  });

  it('with one worker launches the next item only after the previous result was consumed', async () => {
    const events: string[] = [];
    for await (const r of iterOrderedConcurrent([0, 1, 2], 1, async (i) => (events.push(`start${i}`), i))) {
      events.push(`consume${r.value}`);
    }
    expect(events).toEqual(['start0', 'consume0', 'start1', 'consume1', 'start2', 'consume2']);
  });

  it('reports a failing item in place without stopping the others', async () => {
    const seen: Array<{ item: number; error?: unknown; value?: number }> = [];
    for await (const r of iterOrderedConcurrent([0, 1, 2], 2, async (i) => {
      if (i === 1) throw new Error('boom');
      return i;
    })) seen.push(r);
    expect(seen.map((r) => r.item)).toEqual([0, 1, 2]);
    expect((seen[1].error as Error).message).toBe('boom');
    expect(seen[2].value).toBe(2);
  });

  it('stops launching when interrupted but still delivers in-flight items', async () => {
    let interrupted = false;
    const started: number[] = [];
    const out: number[] = [];
    for await (const r of iterOrderedConcurrent([0, 1, 2, 3, 4, 5], 2, async (i) => {
      started.push(i);
      await sleep(5);
      return i;
    }, () => interrupted)) {
      out.push(r.value!);
      interrupted = true;
    }
    expect(out).toEqual([0, 1]);
    expect(started).toEqual([0, 1]);
  });

  it('cancels in-flight work when the consumer stops early', async () => {
    let aborted = false;
    const gen = iterOrderedConcurrent([0, 1], 2, (i, signal) =>
      i === 0 ? Promise.resolve(0) : new Promise<number>((_, reject) => signal.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')); })));
    for await (const _ of gen) break;
    expect(aborted).toBe(true);
  });
});
