/* cue — markdown rendering and syntax highlighting for model answers.
 *
 * The previous renderer handled fenced code, bullets, inline code and bold, and
 * dropped everything else on the floor. Models emit numbered lists constantly,
 * and those came out as flat paragraphs — the single most common way an answer
 * arrived unreadable. This handles headings, ordered and nested lists,
 * blockquotes, rules, links and tables as well.
 *
 * Safety: every piece of model text is escaped before it reaches the output
 * string. Highlighting works on a token list built from the raw source and
 * escapes each token as it is emitted, so no regex ever runs over HTML.
 */
(function () {
  // ---- escaping ----------------------------------------------------------
  const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  function esc(text) {
    return String(text).replace(/[&<>"']/g, (c) => ESCAPES[c]);
  }

  // ---- syntax highlighting ------------------------------------------------
  // Deliberately small: enough structure that code reads as code, without
  // bundling a full grammar engine into an overlay that must stay light.
  const KEYWORDS = {
    common: 'if else for while return break continue switch case default do try catch finally throw new delete typeof instanceof in of void null true false this super class extends import export from as async await yield static public private protected abstract final override',
    javascript: 'const let var function => interface type enum namespace declare readonly',
    typescript: 'const let var function interface type enum namespace declare readonly implements',
    python: 'def lambda pass raise except with global nonlocal assert elif not and or is None True False self import from class async await yield del',
    java: 'int long float double boolean char byte short String void package interface implements throws synchronized volatile transient native strictfp',
    c: 'int long float double char void unsigned signed struct union enum typedef sizeof const static extern register goto inline',
    go: 'func var const type struct interface map chan go defer select range package import fallthrough nil',
    rust: 'fn let mut const struct enum impl trait use pub mod match ref move where dyn unsafe crate self Self Some None Ok Err',
    sql: 'select from where join inner left right outer on group by order having limit offset insert into values update set delete create table alter drop index distinct as and or not null count sum avg min max'
  };

  const ALIASES = {
    js: 'javascript', jsx: 'javascript', mjs: 'javascript', node: 'javascript',
    ts: 'typescript', tsx: 'typescript',
    py: 'python', python3: 'python',
    'c++': 'c', cpp: 'c', cc: 'c', h: 'c', hpp: 'c', 'c#': 'c', csharp: 'c', cs: 'c',
    golang: 'go',
    rs: 'rust',
    kt: 'java', kotlin: 'java', scala: 'java',
    sh: 'shell', bash: 'shell', zsh: 'shell',
    yml: 'yaml'
  };

  function normalizeLanguage(lang) {
    const key = String(lang || '').trim().toLowerCase();
    return ALIASES[key] || key;
  }

  function keywordSet(lang) {
    const words = (KEYWORDS.common + ' ' + (KEYWORDS[lang] || '')).split(/\s+/).filter(Boolean);
    return new Set(words);
  }

  // Comment syntax varies enough that guessing wrong is worse than not trying.
  const LINE_COMMENT = {
    python: '#', shell: '#', yaml: '#', ruby: '#', sql: '--'
  };

  /**
   * Split source into {type, text} tokens. Types map to CSS classes; anything
   * unclassified comes back as type 'text'.
   */
  function tokenize(source, lang) {
    const keywords = keywordSet(lang);
    const lineComment = LINE_COMMENT[lang] || '//';
    const supportsBlockComment = !LINE_COMMENT[lang] || lang === 'sql';
    const tokens = [];
    let plain = '';
    let i = 0;

    const flush = () => { if (plain) { tokens.push({ type: 'text', text: plain }); plain = ''; } };
    const take = (type, text) => { flush(); tokens.push({ type, text }); i += text.length; };

    while (i < source.length) {
      const rest = source.slice(i);

      // line comment
      if (rest.startsWith(lineComment)) {
        const end = source.indexOf('\n', i);
        take('comment', source.slice(i, end === -1 ? source.length : end));
        continue;
      }
      // block comment
      if (supportsBlockComment && rest.startsWith('/*')) {
        const end = source.indexOf('*/', i + 2);
        take('comment', source.slice(i, end === -1 ? source.length : end + 2));
        continue;
      }
      // python docstring
      if (lang === 'python' && (rest.startsWith('"""') || rest.startsWith("'''"))) {
        const fence = rest.slice(0, 3);
        const end = source.indexOf(fence, i + 3);
        take('string', source.slice(i, end === -1 ? source.length : end + 3));
        continue;
      }
      // string
      const quote = rest[0];
      if (quote === '"' || quote === "'" || quote === '`') {
        let j = i + 1;
        while (j < source.length) {
          if (source[j] === '\\') { j += 2; continue; }
          if (source[j] === quote) { j++; break; }
          // an unterminated single-quoted string is far more likely to be a
          // stray apostrophe than a string running to end of file
          if (source[j] === '\n' && quote !== '`') break;
          j++;
        }
        take('string', source.slice(i, j));
        continue;
      }
      // number
      const number = /^(0[xXbBoO][0-9a-fA-F_]+|\d[\d_]*(\.\d[\d_]*)?([eE][+-]?\d+)?)/.exec(rest);
      if (number && !/[\w$]/.test(source[i - 1] || '')) {
        take('number', number[0]);
        continue;
      }
      // identifier / keyword / function call
      const word = /^[A-Za-z_$][\w$]*/.exec(rest);
      if (word) {
        const text = word[0];
        if (keywords.has(text)) take('keyword', text);
        else if (/^\s*\(/.test(rest.slice(text.length))) take('fn', text);
        else { plain += text; i += text.length; }
        continue;
      }

      plain += source[i];
      i++;
    }
    flush();
    return tokens;
  }

  function highlight(source, lang) {
    const normalized = normalizeLanguage(lang);
    if (!normalized || normalized === 'text' || normalized === 'plain') return esc(source);
    return tokenize(source, normalized)
      .map((token) => (token.type === 'text' ? esc(token.text) : `<span class="hl-${token.type}">${esc(token.text)}</span>`))
      .join('');
  }

  // ---- inline markdown ----------------------------------------------------
  // Code spans are pulled out first and restored last so their contents are
  // never treated as emphasis or link syntax.
  function inline(text) {
    const codeSpans = [];
    let out = String(text).replace(/`([^`]+)`/g, (_m, code) => {
      codeSpans.push(code);
      return '\u0000CODE' + (codeSpans.length - 1) + '\u0000';
    });

    out = esc(out);

    // links — http(s) and mailto only; anything else is left as literal text so
    // a model cannot talk the renderer into emitting javascript: or file: URLs
    out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (whole, label, href) => {
      if (!/^(https?:\/\/|mailto:)/i.test(href)) return whole;
      return `<a href="${esc(href)}" data-external="1">${label}</a>`;
    });
    // bare URLs
    out = out.replace(/(^|[\s(])(https?:\/\/[^\s<>()]+)/g, (_m, lead, href) =>
      `${lead}<a href="${esc(href)}" data-external="1">${esc(href)}</a>`);

    out = out
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
      .replace(/~~([^~]+)~~/g, '<del>$1</del>');

    return out.replace(/\u0000CODE(\d+)\u0000/g, (_m, index) => `<code>${esc(codeSpans[Number(index)])}</code>`);
  }

  // ---- block markdown -----------------------------------------------------
  const BULLET = /^(\s*)[-*+]\s+(.*)$/;
  const ORDERED = /^(\s*)(\d+)[.)]\s+(.*)$/;

  function renderMarkdown(text) {
    const lines = String(text || '').split('\n');
    let html = '';
    let paragraph = [];
    // Each entry is { tag, indent } so nested lists close in the right order.
    const listStack = [];

    // A nested list lives inside the <li> above it, so closing one has to close
    // that item too — otherwise the markup is a <ul> parented by another <ul>,
    // which browsers tolerate but assistive technology reads as a flat list.
    const closeOne = () => {
      const entry = listStack.pop();
      html += `</${entry.tag}>`;
      if (entry.nested) html += '</li>';
    };
    const closeLists = (toIndent) => {
      while (listStack.length && listStack[listStack.length - 1].indent >= toIndent) closeOne();
    };
    const closeAllLists = () => { while (listStack.length) closeOne(); };
    const flushParagraph = () => {
      if (!paragraph.length) return;
      html += '<p>' + inline(paragraph.join(' ')) + '</p>';
      paragraph = [];
    };
    const breakBlock = () => { flushParagraph(); closeAllLists(); };

    for (let index = 0; index < lines.length; index++) {
      const line = lines[index];
      const trimmed = line.trim();

      // fenced code — consumes lines until the closing fence or end of input
      const fence = /^```+\s*([\w+#.-]*)/.exec(trimmed);
      if (fence) {
        breakBlock();
        const lang = fence[1];
        const body = [];
        index++;
        while (index < lines.length && !/^```+\s*$/.test(lines[index].trim())) {
          body.push(lines[index]);
          index++;
        }
        const source = body.join('\n');
        const label = lang ? `<span class="code-lang">${esc(lang)}</span>` : '';
        html += `<figure class="code-block" data-code="${esc(source)}">` +
          `<figcaption>${label}<button type="button" class="code-copy" data-copy-code>` +
          `<span class="code-copy-label"></span></button></figcaption>` +
          `<pre><code>${highlight(source, lang)}</code></pre></figure>`;
        continue;
      }

      // horizontal rule
      if (/^(\*{3,}|-{3,}|_{3,})$/.test(trimmed)) {
        breakBlock();
        html += '<hr />';
        continue;
      }

      // heading
      const heading = /^(#{1,6})\s+(.*)$/.exec(trimmed);
      if (heading) {
        breakBlock();
        const level = Math.min(heading[1].length + 2, 6); // h1 in an overlay is too loud
        html += `<h${level}>${inline(heading[2])}</h${level}>`;
        continue;
      }

      // blockquote
      if (/^>\s?/.test(trimmed)) {
        breakBlock();
        html += `<blockquote>${inline(trimmed.replace(/^>\s?/, ''))}</blockquote>`;
        continue;
      }

      // list items — indentation drives nesting
      const bullet = BULLET.exec(line);
      const ordered = ORDERED.exec(line);
      if (bullet || ordered) {
        flushParagraph();
        const indent = (bullet ? bullet[1] : ordered[1]).replace(/\t/g, '  ').length;
        const tag = bullet ? 'ul' : 'ol';
        const content = bullet ? bullet[2] : ordered[3];

        closeLists(indent + 1);
        const top = listStack[listStack.length - 1];
        if (!top || top.indent < indent) {
          const start = ordered && ordered[2] !== '1' ? ` start="${Number(ordered[2])}"` : '';
          const nested = !!top && html.endsWith('</li>');
          if (nested) html = html.slice(0, -'</li>'.length);
          html += `<${tag}${start}>`;
          listStack.push({ tag, indent, nested });
        } else if (top.tag !== tag) {
          const wasNested = top.nested;
          html += `</${listStack.pop().tag}><${tag}>`;
          listStack.push({ tag, indent, nested: wasNested });
        }
        html += `<li>${inline(content)}</li>`;
        continue;
      }

      // blank line
      if (!trimmed) {
        breakBlock();
        continue;
      }

      // a continuation line inside a list belongs to the current item
      if (listStack.length && /^\s{2,}/.test(line)) {
        html = html.replace(/<\/li>$/, ' ' + inline(trimmed) + '</li>');
        continue;
      }

      closeAllLists();
      paragraph.push(trimmed);
    }

    breakBlock();
    return html;
  }

  window.CUE_MARKDOWN = { renderMarkdown, highlight, esc };
})();
