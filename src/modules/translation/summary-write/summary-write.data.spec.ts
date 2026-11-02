import { fieldPrint, readWriteData, sectionPrint, toJson } from './summary-write.data';

/**
 * Разбор данных хода из `ContentDraft.data` (`F06-2`, `tech.md` §2): строку пишет код, но шаг и
 * ответ не падают на элементе не той формы - он пропускается, как у заготовок `F05-10`.
 */
describe('readWriteData', () => {
  const item = {
    target: 'section',
    number: 2,
    title: 'Chapter 2',
    readerChapter: 2,
    text: 'Anna.',
    attempt: 2,
    verdict: 'flags',
    remarks: [{ code: 'JUNK', where: 'x', note: 'y', by: 'code' }],
    review: { kind: 'answered', model: 'openai/gpt-6-luna' },
    outcome: 'written',
    failedReason: null,
    authorModel: 'z-ai/glm-5.3',
    chapters: [2, 3],
    fieldHash: null,
    fieldMode: null,
    fieldBase: null,
    regenFailedReason: null,
    regen: {
      operationId: 'op2',
      remark: 'Fix it',
      pending: null,
      produced: true,
      tail: false,
      tailDone: ['full'],
    },
  };

  it('a well-formed run reads back as written', () => {
    const data = readWriteData({
      items: [item],
      owns: { sections: true, full: false, brief: true },
      written: { full: 'h1', brief: null, sections: { '2': 'h2' } },
      plannedSections: 3,
      pending: null,
    });
    expect(data).toEqual({
      items: [item],
      owns: { sections: true, full: false, brief: true },
      written: { full: 'h1', brief: null, sections: { '2': 'h2' } },
      plannedSections: 3,
      pending: null,
    });
  });

  it('a garbage element keeps its place as a failed placeholder and goes back unchanged (круг 3)', () => {
    const raw = { items: [item, { target: 'chapter' }, { ...item, number: 3 }] };
    const data = readWriteData(raw);
    expect(data.items).toHaveLength(3);
    expect(data.items[1]).toMatchObject({
      verdict: 'failed',
      outcome: 'none',
      failedReason: 'DRAFT_DATA_INVALID',
    });
    expect(data.items[2].number).toBe(3);
    expect((toJson(data) as { items: unknown[] }).items[1]).toEqual({ target: 'chapter' });
    expect((toJson(data) as { items: unknown[] }).items[2]).not.toHaveProperty('broken');
  });

  it('garbage fields of a well-formed element fall back; nothing throws', () => {
    const data = readWriteData({
      items: [
        { ...item, remarks: [{ code: 'NOPE', where: 'x', note: 'y', by: 'code' }, 7] },
        { ...item, review: { kind: 'answered' }, regen: { remark: 'no op' }, fieldBase: [1, 'h'] },
      ],
      owns: 'all',
      written: { sections: { '1': 5 } },
    });
    expect(data.items).toHaveLength(2);
    expect(data.items[0].remarks).toEqual([]);
    expect(data.items[1]).toMatchObject({ review: null, regen: null, fieldBase: ['h'] });
    expect(data.owns).toEqual({ sections: false, full: false, brief: false });
    expect(data.written).toEqual({ full: null, brief: null, sections: {} });
    expect(readWriteData(null).items).toEqual([]);
  });

  it('a saved text to resume with keeps its check only when the review is well-formed', () => {
    const pending = {
      key: 'section:1',
      operationId: 'op1',
      resume: {
        draft: 'Text',
        attempt: 1,
        authorModel: 'z-ai/glm-5.3',
        checked: { remarks: [], review: { kind: 'too_long' } },
      },
    };
    expect(readWriteData({ pending }).pending).toEqual(pending);
    const broken = { ...pending, resume: { ...pending.resume, attempt: 3 } };
    expect(readWriteData({ pending: broken }).pending).toBeNull();
  });
});

describe('field prints', () => {
  it('a print changes with any part of the content, null differs from an empty string', () => {
    const base = { title: 'T', text: '<p>A</p>', readerChapter: 1 };
    expect(sectionPrint(base)).toBe(sectionPrint({ ...base }));
    expect(sectionPrint(base)).not.toBe(sectionPrint({ ...base, readerChapter: 2 }));
    expect(sectionPrint(base)).not.toBe(sectionPrint({ ...base, title: 'U' }));
    expect(fieldPrint(null)).not.toBe(fieldPrint(''));
  });
});
