const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// markdown.js is a browser IIFE that publishes onto window. Run it in a VM with
// a stub window so the same file the renderer loads is the file under test.
function loadMarkdown() {
  const source = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'markdown.js'), 'utf8');
  const context = { window: {} };
  vm.createContext(context);
  vm.runInContext(source, context);
  return context.window.CUE_MARKDOWN;
}

const { renderMarkdown, highlight, esc } = loadMarkdown();

test('escapes every character that could break out of text', () => {
  assert.strictEqual(esc('<script>&"\'</script>'), '&lt;script&gt;&amp;&quot;&#39;&lt;/script&gt;');
});

test('renders a numbered list as an ordered list', () => {
  // The regression that motivated this renderer: models emit numbered lists
  // constantly and the previous version flattened them into a paragraph.
  const html = renderMarkdown('1. first\n2. second\n3. third');
  assert.match(html, /<ol>/);
  assert.strictEqual((html.match(/<li>/g) || []).length, 3);
  assert.match(html, /<li>first<\/li>/);
  assert.doesNotMatch(html, /<p>1\./);
});

test('keeps a non-1 starting number', () => {
  assert.match(renderMarkdown('3. third\n4. fourth'), /<ol start="3">/);
});

test('nests a deeper list inside the item above it', () => {
  const html = renderMarkdown('- outer\n  - inner\n- outer again');
  // The nested <ul> must sit inside the <li>, not as a sibling of it.
  assert.match(html, /<li>outer<ul><li>inner<\/li><\/ul><\/li>/);
});

test('renders headings below h1 so an overlay never shouts', () => {
  assert.match(renderMarkdown('# Title'), /<h3>Title<\/h3>/);
  assert.match(renderMarkdown('### Deeper'), /<h5>Deeper<\/h5>/);
});

test('renders blockquotes and horizontal rules', () => {
  assert.match(renderMarkdown('> quoted'), /<blockquote>quoted<\/blockquote>/);
  assert.match(renderMarkdown('---'), /<hr \/>/);
});

test('renders inline emphasis, code and strikethrough', () => {
  const html = renderMarkdown('**bold** and *italic* and `code` and ~~gone~~');
  assert.match(html, /<strong>bold<\/strong>/);
  assert.match(html, /<em>italic<\/em>/);
  assert.match(html, /<code>code<\/code>/);
  assert.match(html, /<del>gone<\/del>/);
});

test('never treats the contents of a code span as markup', () => {
  const html = renderMarkdown('use `<b>**x**</b>` here');
  assert.match(html, /<code>&lt;b&gt;\*\*x\*\*&lt;\/b&gt;<\/code>/);
  assert.doesNotMatch(html, /<strong>/);
});

test('links only http, https and mailto', () => {
  assert.match(renderMarkdown('[docs](https://example.com)'), /<a href="https:\/\/example\.com"/);
  assert.match(renderMarkdown('[mail](mailto:a@b.co)'), /<a href="mailto:a@b\.co"/);
  // A javascript: URL must survive as literal text, never as an anchor.
  const hostile = renderMarkdown('[click](javascript:alert(1))');
  assert.doesNotMatch(hostile, /<a /);
  assert.match(hostile, /\[click\]/);
});

test('autolinks a bare url', () => {
  assert.match(renderMarkdown('see https://example.com now'), /<a href="https:\/\/example\.com"/);
});

test('renders a fenced code block with its language and copy affordance', () => {
  const html = renderMarkdown('```python\nprint("hi")\n```');
  assert.match(html, /class="code-block"/);
  assert.match(html, /<span class="code-lang">python<\/span>/);
  assert.match(html, /data-copy-code/);
  assert.match(html, /data-code="print\(&quot;hi&quot;\)"/);
});

test('closes an unterminated code fence instead of dropping the code', () => {
  const html = renderMarkdown('```js\nconst a = 1;');
  assert.match(html, /class="code-block"/);
  assert.match(html, /a = 1/);
});

test('highlights keywords, strings, numbers and comments', () => {
  const html = highlight('const x = "hi"; // note\nlet n = 42;', 'js');
  assert.match(html, /<span class="hl-keyword">const<\/span>/);
  assert.match(html, /<span class="hl-string">&quot;hi&quot;<\/span>/);
  assert.match(html, /<span class="hl-comment">\/\/ note<\/span>/);
  assert.match(html, /<span class="hl-number">42<\/span>/);
});

test('uses # comments for python and -- for sql', () => {
  assert.match(highlight('# note\nx = 1', 'python'), /<span class="hl-comment"># note<\/span>/);
  assert.match(highlight('-- note\nselect 1', 'sql'), /<span class="hl-comment">-- note<\/span>/);
  // A # in JavaScript is a private field, not a comment.
  assert.doesNotMatch(highlight('const a = 1; # not a comment', 'js'), /hl-comment/);
});

test('escapes code that is highlighted', () => {
  assert.doesNotMatch(highlight('const a = "<img onerror=x>";', 'js'), /<img/);
});

test('leaves an unknown language escaped but unstyled', () => {
  const html = highlight('<b>plain</b>', 'brainfuck');
  assert.strictEqual(html, '&lt;b&gt;plain&lt;/b&gt;');
});

test('survives empty and whitespace-only input', () => {
  assert.strictEqual(renderMarkdown(''), '');
  assert.strictEqual(renderMarkdown('   \n\n  '), '');
  assert.strictEqual(renderMarkdown(null), '');
});
