import { summaryPlanOf } from './content-draft.service';
import { answerToHtml, chaptersText, editorQuestion, htmlToParagraphs } from './content-draft.text';

describe('content draft text (F05-10)', () => {
  it('answerToHtml: paragraphs, "## " subheadings, model markup as text', () => {
    expect(answerToHtml('One\nline.\n\n## Part One\n\n**Two** <script>x</script>')).toBe(
      '<p>One line.</p><h2>Part One</h2><p>**Two** &lt;script&gt;x&lt;/script&gt;</p>',
    );
    expect(answerToHtml('  \n\n  ')).toBe('');
    // Подзаголовок без пустой строки после него: абзац остаётся абзацем.
    expect(answerToHtml('## Part One\nThe count arrives.\nHe waits.')).toBe(
      '<h2>Part One</h2><p>The count arrives. He waits.</p>',
    );
    // `###` - тот же подзаголовок, пустой `##` не попадает в текст.
    expect(answerToHtml('### Part Two\n\n##\n\nEnd.')).toBe('<h2>Part Two</h2><p>End.</p>');
    expect(answerToHtml('#hashtag is text')).toBe('<p>#hashtag is text</p>');
  });

  it('htmlToParagraphs: saved rich HTML to paragraphs, headings kept, image attributes and empty blocks dropped', () => {
    expect(
      htmlToParagraphs(
        '<h2>Part&nbsp;One</h2><p>Anna <em>arrives</em>.</p><p></p><figure><img src="a.jpg" alt="Alt"></figure>',
      ),
    ).toBe('## Part One\n\nAnna arrives.');
  });

  it('chaptersText: the reader chapter mark before each chapter', () => {
    expect(
      chaptersText([
        { number: 2, title: 'Two', content: '<p>A.</p>' },
        { number: 3, title: '', content: '<p>B.</p>' },
      ]),
    ).toBe('[READER CHAPTER 2] Two\n\nA.\n\n[READER CHAPTER 3]\n\nB.');
  });

  it('editorQuestion: "none" in any language is no question', () => {
    for (const none of ['none', 'None.', 'нет', ' ', 'ninguna'])
      expect(editorQuestion(none)).toBeNull();
    expect(editorQuestion(' Is the name Ann or Anna? ')).toBe('Is the name Ann or Anna?');
  });

  it('summaryPlanOf: plan entries of the right form only', () => {
    expect(
      summaryPlanOf({
        summaryPlan: [
          { number: 1, title: 'Chapter 1', chapters: [1, 'x', 2], why: '' },
          { number: 'two', title: 'Bad', chapters: [] },
          null,
        ],
      }),
    ).toEqual([{ number: 1, title: 'Chapter 1', chapters: [1, 2] }]);
    expect(summaryPlanOf(null)).toEqual([]);
  });
});
