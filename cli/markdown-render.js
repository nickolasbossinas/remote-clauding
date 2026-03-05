// Markdown-to-ANSI renderer using marked lexer + cli-highlight
// Lexes markdown into tokens, walks them, emits ANSI-styled terminal strings.

import { marked } from 'marked';
import { highlight } from 'cli-highlight';

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const UNBOLD = '\x1b[22m';
const DIM = '\x1b[2m';
const ITALIC = '\x1b[3m';
const UNITALIC = '\x1b[23m';
const UNDERLINE = '\x1b[4m';
const STRIKETHROUGH = '\x1b[9m';
const UNSTRIKETHROUGH = '\x1b[29m';
const CYAN = '\x1b[36m';

const BLOCKQUOTE_BAR = `${DIM}\u2502${RESET}`;

/**
 * Render markdown text to ANSI-styled terminal string.
 * @param {string} text - Raw markdown text
 * @returns {string} ANSI-formatted string (trimmed, no trailing newlines)
 */
export function renderMarkdown(text) {
  const tokens = marked.lexer(text);
  return renderTokens(tokens).replace(/\n{3,}/g, '\n\n').trimEnd();
}

function renderTokens(tokens) {
  let out = '';
  for (const token of tokens) {
    out += renderToken(token, '');
  }
  return out;
}

function renderToken(token, indent) {
  switch (token.type) {
    case 'heading': {
      const content = renderInline(token.tokens);
      if (token.depth === 1) {
        return `${indent}${BOLD}${ITALIC}${UNDERLINE}${content}${RESET}\n\n`;
      }
      return `${indent}${BOLD}${content}${RESET}\n\n`;
    }

    case 'paragraph':
      return `${indent}${renderInline(token.tokens)}\n\n`;

    case 'code': {
      let code = token.text;
      try {
        code = highlight(code, {
          language: token.lang || undefined,
          ignoreIllegals: true,
        });
      } catch {
        // fallback to raw code
      }
      const label = token.lang ? ` ${token.lang} ` : '';
      const topBar = `${DIM}${'─'.repeat(3)}${label}${'─'.repeat(Math.max(1, 37 - label.length))}${RESET}`;
      const bottomBar = `${DIM}${'─'.repeat(40)}${RESET}`;
      const lines = code.split('\n').map(l => `${indent}  ${l}`).join('\n');
      return `${indent}${topBar}\n${lines}\n${indent}${bottomBar}\n\n`;
    }

    case 'blockquote': {
      const content = renderTokens(token.tokens).trimEnd();
      const lines = content.split('\n').map(l => `${indent}${BLOCKQUOTE_BAR} ${DIM}${l}${RESET}`);
      return lines.join('\n') + '\n\n';
    }

    case 'list': {
      let out = '';
      token.items.forEach((item, i) => {
        const bullet = token.ordered ? `${(token.start || 1) + i}. ` : '- ';
        out += renderListItem(item, indent, bullet);
      });
      return out + '\n';
    }

    case 'table':
      return renderTable(token, indent) + '\n';

    case 'hr':
      return `${indent}${DIM}${'─'.repeat(40)}${RESET}\n\n`;

    case 'space':
      return '\n';

    case 'html':
      return `${indent}${DIM}${token.raw.trimEnd()}${RESET}\n`;

    default:
      return token.raw || '';
  }
}

function renderListItem(item, indent, bullet) {
  let out = `${indent}${bullet}`;
  let first = true;

  for (const token of item.tokens) {
    if (token.type === 'text') {
      const text = token.tokens ? renderInline(token.tokens) : token.text;
      if (first) {
        out += text + '\n';
        first = false;
      } else {
        out += `${indent}  ${text}\n`;
      }
    } else if (token.type === 'paragraph') {
      const text = renderInline(token.tokens);
      if (first) {
        out += text + '\n';
        first = false;
      } else {
        out += `${indent}  ${text}\n`;
      }
    } else if (token.type === 'list') {
      // Nested list
      token.items.forEach((subItem, i) => {
        const subBullet = token.ordered ? `${(token.start || 1) + i}. ` : '- ';
        out += renderListItem(subItem, indent + '  ', subBullet);
      });
    } else {
      out += renderToken(token, indent + '  ');
      first = false;
    }
  }

  return out;
}

function renderInline(tokens) {
  if (!tokens) return '';
  let out = '';
  for (const t of tokens) {
    switch (t.type) {
      case 'strong':
        out += `${BOLD}${renderInline(t.tokens)}${UNBOLD}`;
        break;
      case 'em':
        out += `${ITALIC}${renderInline(t.tokens)}${UNITALIC}`;
        break;
      case 'codespan':
        out += `${CYAN}${t.text}${RESET}`;
        break;
      case 'link':
        out += `${renderInline(t.tokens)} ${DIM}(${t.href})${RESET}`;
        break;
      case 'del':
        out += `${STRIKETHROUGH}${renderInline(t.tokens)}${UNSTRIKETHROUGH}`;
        break;
      case 'text':
        out += t.text;
        break;
      case 'br':
        out += '\n';
        break;
      case 'escape':
        out += t.text;
        break;
      case 'image':
        out += `${DIM}[${t.text}](${t.href})${RESET}`;
        break;
      default:
        out += t.raw || '';
    }
  }
  return out;
}

function renderTable(token, indent) {
  const numCols = token.header.length;
  const colWidths = new Array(numCols).fill(0);

  // Measure header cells
  for (let i = 0; i < numCols; i++) {
    colWidths[i] = Math.max(colWidths[i], stripAnsi(renderInline(token.header[i].tokens)).length);
  }

  // Measure body cells
  for (const row of token.rows) {
    for (let i = 0; i < numCols; i++) {
      if (row[i]) {
        colWidths[i] = Math.max(colWidths[i], stripAnsi(renderInline(row[i].tokens)).length);
      }
    }
  }

  function padCell(text, width, align) {
    const len = stripAnsi(text).length;
    const pad = Math.max(0, width - len);
    if (align === 'center') {
      const left = Math.floor(pad / 2);
      return ' '.repeat(left) + text + ' '.repeat(pad - left);
    } else if (align === 'right') {
      return ' '.repeat(pad) + text;
    }
    return text + ' '.repeat(pad);
  }

  const hLine = (left, mid, right) => {
    const segs = colWidths.map(w => '─'.repeat(w + 2));
    return `${indent}${DIM}${left}${segs.join(mid)}${right}${RESET}\n`;
  };

  const dataRow = (cells) => {
    const padded = cells.map((text, i) => padCell(text, colWidths[i], token.align[i]));
    return `${indent}${DIM}│${RESET} ${padded.join(` ${DIM}│${RESET} `)} ${DIM}│${RESET}\n`;
  };

  let out = '';

  // Top border
  out += hLine('┌', '┬', '┐');

  // Header row
  const headerCells = token.header.map(cell => renderInline(cell.tokens));
  out += dataRow(headerCells);

  // Header/body separator
  out += hLine('├', '┼', '┤');

  // Body rows with separators between them
  for (let r = 0; r < token.rows.length; r++) {
    if (r > 0) out += hLine('├', '┼', '┤');
    const cells = token.rows[r].map(cell => cell ? renderInline(cell.tokens) : '');
    out += dataRow(cells);
  }

  // Bottom border
  out += hLine('└', '┴', '┘');

  return out;
}

function stripAnsi(str) {
  return str.replace(/\x1b\[[0-9;]*m/g, '');
}
