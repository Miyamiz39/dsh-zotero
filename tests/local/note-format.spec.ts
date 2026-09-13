import { describe, expect, it } from 'vitest'
import { markdownToNoteHtml } from '../../src/local/note-format.js'

describe('blocks', () => {
  it('renders blank-line-separated paragraphs and joins soft-wrapped lines', () => {
    expect(markdownToNoteHtml('first para\nstill first\n\nsecond para')).toBe(
      '<p>first para still first</p>\n<p>second para</p>',
    )
  })

  it('renders ATX headings up to level four and keeps deeper hashes literal', () => {
    expect(markdownToNoteHtml('# One\n\n## Two\n\n### Three\n\n#### Four\n\n##### Five')).toBe(
      '<h1>One</h1>\n<h2>Two</h2>\n<h3>Three</h3>\n<h4>Four</h4>\n<p>##### Five</p>',
    )
  })

  it('renders a horizontal rule from --- and *** lines', () => {
    expect(markdownToNoteHtml('---\n\n***')).toBe('<hr/>\n<hr/>')
  })

  it('renders single-level quotes as one paragraph per block', () => {
    expect(markdownToNoteHtml('> quoted line\n> still quoted\n\nafter')).toBe(
      '<blockquote><p>quoted line still quoted</p></blockquote>\n<p>after</p>',
    )
  })

  it('collapses runs of blank lines', () => {
    expect(markdownToNoteHtml('a\n\n\n\nb')).toBe('<p>a</p>\n<p>b</p>')
  })

  it('returns the empty string for empty input', () => {
    expect(markdownToNoteHtml('')).toBe('')
  })
})

describe('emphasis and code', () => {
  it('renders bold and italic but keeps underscore text literal', () => {
    expect(markdownToNoteHtml('**bold** and *italic* and max_export_refs')).toBe(
      '<p><strong>bold</strong> and <em>italic</em> and max_export_refs</p>',
    )
  })

  it('keeps inline code spans unformatted and escaped', () => {
    expect(markdownToNoteHtml('`a *b* <tag>` stays literal')).toBe(
      '<p><code>a *b* &lt;tag&gt;</code> stays literal</p>',
    )
  })

  it('keeps an unmatched backtick literal', () => {
    expect(markdownToNoteHtml('a ` b')).toBe('<p>a ` b</p>')
  })

  it('escapes fenced code verbatim, CJK included, with no formatting inside', () => {
    expect(markdownToNoteHtml('```js\nconst s = "<b>加粗</b>";\n```')).toBe(
      '<pre><code>const s = &quot;&lt;b&gt;加粗&lt;/b&gt;&quot;;</code></pre>',
    )
  })

  it('consumes an unterminated fence to the end of the input', () => {
    expect(markdownToNoteHtml('```\nnever closed')).toBe('<pre><code>never closed</code></pre>')
  })
})

describe('links', () => {
  it('renders https and zotero links, keeping their text formattable', () => {
    expect(
      markdownToNoteHtml('[**paper**](https://example.io/a) and [记](zotero://user/0/items/ABCD1234)'),
    ).toBe(
      '<p><a href="https://example.io/a"><strong>paper</strong></a> and ' +
        '<a href="zotero://user/0/items/ABCD1234">记</a></p>',
    )
  })

  it('keeps unknown schemes as literal text instead of anchors', () => {
    expect(markdownToNoteHtml('[click](javascript:alert(1))')).toBe(
      '<p>[click](javascript:alert(1))</p>',
    )
    expect(markdownToNoteHtml('[rel](other/page)')).toBe('<p>[rel](other/page)</p>')
  })

  it('cannot break out of the href attribute: quotes arrive escaped', () => {
    const html = markdownToNoteHtml('[x](https://a.io/"onmouseover="y")')
    expect(html).toContain('<a href="https://a.io/&quot;onmouseover=&quot;y&quot;">x</a>')
    expect(html).not.toContain('"onmouseover')
  })
})

describe('lists', () => {
  it('renders unordered and ordered lists, including 1) markers', () => {
    expect(markdownToNoteHtml('- one\n- two\n\n1. first\n2) second')).toBe(
      '<ul><li>one</li><li>two</li></ul>\n<ol><li>first</li><li>second</li></ol>',
    )
  })

  it('renders one nested level, with a later continuation as a trailing paragraph', () => {
    expect(markdownToNoteHtml('- outer\n  - inner\n  - inner 2\n  continued\n- next')).toBe(
      '<ul><li>outer<ul><li>inner</li><li>inner 2</li></ul><p>continued</p></li><li>next</li></ul>',
    )
  })

  it('joins a continuation line that comes before any nested item into the item', () => {
    expect(markdownToNoteHtml('- outer\n  continued\n  - inner')).toBe(
      '<ul><li>outer continued<ul><li>inner</li></ul></li></ul>',
    )
  })

  it('keeps list-item formatting working', () => {
    expect(markdownToNoteHtml('1. `code` and **bold**\n2. [a](https://b.io)')).toBe(
      '<ol><li><code>code</code> and <strong>bold</strong></li><li><a href="https://b.io">a</a></li></ol>',
    )
  })
})

describe('tables', () => {
  it('renders a pipe table with the documented separator row', () => {
    expect(markdownToNoteHtml('| method | n |\n|---|---|\n| A | 4 |\n| B | 5 |')).toBe(
      '<table><thead><tr><th>method</th><th>n</th></tr></thead><tbody><tr><td>A</td><td>4</td></tr><tr><td>B</td><td>5</td></tr></tbody></table>',
    )
  })

  it('accepts alignment colons and header rows without outer pipes', () => {
    expect(markdownToNoteHtml('a | b\n|:---|---:|\n1 | 2')).toBe(
      '<table><thead><tr><th>a</th><th>b</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>',
    )
  })

  it('pads short rows and truncates long ones to the header width', () => {
    expect(markdownToNoteHtml('| a | b |\n|---|---|\n| 1 |\n| 1 | 2 | 3 |')).toBe(
      '<table><thead><tr><th>a</th><th>b</th></tr></thead><tbody><tr><td>1</td><td></td></tr><tr><td>1</td><td>2</td></tr></tbody></table>',
    )
  })

  it('keeps pipe lines without a separator row as literal paragraph text', () => {
    expect(markdownToNoteHtml('a | b\nc | d')).toBe('<p>a | b c | d</p>')
  })
})

describe('the escape-unknown guarantee', () => {
  it('never lets raw markup through: scripts and handlers become visible text', () => {
    expect(markdownToNoteHtml('<script>alert(1)</script>')).toBe(
      '<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>',
    )
    expect(markdownToNoteHtml('<img src=x onerror=alert(1)>')).toBe(
      '<p>&lt;img src=x onerror=alert(1)&gt;</p>',
    )
  })

  it('escapes ampersands and angle brackets inside formatted runs', () => {
    expect(markdownToNoteHtml('**a & b** < c >')).toBe(
      '<p><strong>a &amp; b</strong> &lt; c &gt;</p>',
    )
  })

  it('preserves CJK text and typographic punctuation verbatim', () => {
    expect(markdownToNoteHtml('**方法**：“定义 2”给出 —— 见第 3 节。')).toBe(
      '<p><strong>方法</strong>：“定义 2”给出 —— 见第 3 节。</p>',
    )
  })

  it('keeps a paragraph that begins with an emphasized word from becoming a list', () => {
    expect(markdownToNoteHtml('*emphasized* opening line\nmore text')).toBe(
      '<p><em>emphasized</em> opening line more text</p>',
    )
  })

  it('ends a paragraph when a real block starts on the next line', () => {
    expect(markdownToNoteHtml('intro text\n- item')).toBe('<p>intro text</p>\n<ul><li>item</li></ul>')
  })
})
