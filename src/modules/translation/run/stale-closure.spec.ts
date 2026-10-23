import { staleClosure } from './stale-closure';

const at = new Date('2026-10-23T10:00:00Z');

describe('staleClosure (F05-6b)', () => {
  it('a live draft somewhere: languages that never made a draft close, the draft goes on', () => {
    expect(
      staleClosure([
        { id: 'es', bookVersionId: 'v-es', draftCreatedAt: at },
        { id: 'fr', bookVersionId: null, draftCreatedAt: null },
      ]),
    ).toEqual({ hasLiveDraft: true, waiting: ['fr'], stale: ['fr'], deleted: [] });
  });

  it('no live draft: nothing closes as stale - the languages wait for the pause (Р13)', () => {
    expect(
      staleClosure([
        { id: 'es', bookVersionId: null, draftCreatedAt: null },
        { id: 'fr', bookVersionId: null, draftCreatedAt: null },
      ]),
    ).toEqual({ hasLiveDraft: false, waiting: ['es', 'fr'], stale: [], deleted: [] });
  });

  it('a deleted draft is DRAFT_DELETED, not a language without a draft, with or without a live one', () => {
    expect(
      staleClosure([
        { id: 'es', bookVersionId: null, draftCreatedAt: at },
        { id: 'fr', bookVersionId: null, draftCreatedAt: null },
      ]),
    ).toEqual({ hasLiveDraft: false, waiting: ['fr'], stale: [], deleted: ['es'] });
    expect(
      staleClosure([
        { id: 'es', bookVersionId: null, draftCreatedAt: at },
        { id: 'fr', bookVersionId: 'v-fr', draftCreatedAt: at },
        { id: 'pt', bookVersionId: null, draftCreatedAt: null },
      ]),
    ).toEqual({ hasLiveDraft: true, waiting: ['pt'], stale: ['pt'], deleted: ['es'] });
  });

  it('a live draft never closes as stale, even without the creation mark', () => {
    expect(
      staleClosure([
        { id: 'es', bookVersionId: 'v-es', draftCreatedAt: null },
        { id: 'fr', bookVersionId: null, draftCreatedAt: null },
      ]),
    ).toEqual({ hasLiveDraft: true, waiting: ['fr'], stale: ['fr'], deleted: [] });
  });
});
