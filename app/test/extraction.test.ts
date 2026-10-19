import { describe, expect, it } from 'vitest';
import { TranslationExtractor } from '../src/llm/extraction';

const ex = new TranslationExtractor();

describe('TranslationExtractor', () => {
  it('extracts a well-formed response', () => {
    expect(ex.extract('<TRANSLATION>\nBonjour\n</TRANSLATION>')).toBe('Bonjour');
  });

  it('ignores <think> blocks, even ones that contain the tags', () => {
    const raw = '<think>maybe <TRANSLATION>wrong</TRANSLATION></think><TRANSLATION>Bonjour</TRANSLATION>';
    expect(ex.extract(raw)).toBe('Bonjour');
  });

  it('drops everything before an orphan </think>', () => {
    expect(ex.extract('reasoning...</think>\n<TRANSLATION>Salut</TRANSLATION>')).toBe('Salut');
  });

  it('keeps the translation when the tag opens before an orphan </think>', () => {
    const raw = '<TRANSLATION>Salut</think> monde</TRANSLATION>';
    expect(ex.extract(raw)).toBe('Salut</think> monde');
  });

  it('unwraps a markdown code fence', () => {
    expect(ex.extract('```xml\n<TRANSLATION>Hola</TRANSLATION>\n```')).toBe('Hola');
  });

  it('finds tags in the middle of chatter', () => {
    expect(ex.extract('Sure! <TRANSLATION>Hola</TRANSLATION> Enjoy.')).toBe('Hola');
  });

  it('accepts a malformed closing tag', () => {
    expect(ex.extract('<TRANSLATION>Hallo</TRANATION>')).toBe('Hallo');
  });

  it('returns null when there are no tags or the input is empty', () => {
    expect(ex.extract('Just text')).toBeNull();
    expect(ex.extract('')).toBeNull();
    expect(ex.extract(null)).toBeNull();
  });

  it('returns null for an unclosed tag', () => {
    expect(ex.extract('<TRANSLATION>cut off')).toBeNull();
  });
});
