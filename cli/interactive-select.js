// Interactive select: arrow-key navigable option picker for terminal
// Mimics Claude CLI's question UI
// Uses a keyHandler callback instead of managing its own stdin listener.

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const CYAN = '\x1b[36m';
const HIDE_CURSOR = '\x1b[?25l';
const SHOW_CURSOR = '\x1b[?25h';

// Active key handler — set by interactiveSelect, called by the main input loop
let _activeKeyHandler = null;

export function getActiveKeyHandler() {
  return _activeKeyHandler;
}

// Cancel any active interactive select (e.g. when phone dismisses the question)
let _activeReject = null;
let _activeResolve = null;
export function cancelInteractiveSelect() {
  if (_activeKeyHandler) {
    _activeKeyHandler = null;
    process.stdout.write(SHOW_CURSOR);
  }
  if (_activeReject) {
    _activeReject();
    _activeReject = null;
  }
  _activeResolve = null;
}

// Resolve an active interactive select with an answer (e.g. from phone)
export function resolveInteractiveSelect(answer) {
  if (_activeKeyHandler) {
    _activeKeyHandler = null;
    process.stdout.write(SHOW_CURSOR);
  }
  if (_activeResolve) {
    console.log(`${DIM}Selected: ${answer}${RESET}`);
    _activeResolve(answer);
    _activeResolve = null;
  }
  _activeReject = null;
}

/**
 * Show an interactive select menu with arrow key navigation.
 * @param {string} question - The question text
 * @param {{ label: string, description?: string }[]} options - Selectable options
 * @param {{ allowOther?: boolean, maxVisible?: number }} opts
 * @returns {Promise<string>} - The selected option label, or typed text for "Other"
 */
export function interactiveSelect(question, options, opts = {}) {
  const allOptions = [...options];
  if (opts.allowOther !== false) {
    allOptions.push({ label: 'Other', description: 'Type your own answer' });
  }

  const maxVisible = opts.maxVisible || allOptions.length;
  const useViewport = allOptions.length > maxVisible;

  return new Promise((resolve) => {
    _activeReject = () => resolve(null);
    _activeResolve = resolve;
    let selected = 0;
    let scrollOffset = 0;

    function getVisibleRange() {
      if (!useViewport) return { start: 0, end: allOptions.length };
      // Keep selected item visible
      if (selected < scrollOffset) scrollOffset = selected;
      if (selected >= scrollOffset + maxVisible) scrollOffset = selected - maxVisible + 1;
      return { start: scrollOffset, end: scrollOffset + maxVisible };
    }

    function renderOptions() {
      const { start, end } = getVisibleRange();
      const lines = [];
      if (useViewport && start > 0) {
        lines.push(`  ${DIM}↑ ${start} more${RESET}`);
      }
      for (let i = start; i < end; i++) {
        const opt = allOptions[i];
        const pointer = i === selected ? `${CYAN}❯${RESET}` : ' ';
        const label = i === selected ? `${BOLD}${opt.label}${RESET}` : `${DIM}${opt.label}${RESET}`;
        const desc = opt.description ? ` ${DIM}— ${opt.description}${RESET}` : '';
        lines.push(`  ${pointer} ${label}${desc}`);
      }
      if (useViewport && end < allOptions.length) {
        lines.push(`  ${DIM}↓ ${allOptions.length - end} more${RESET}`);
      }
      return lines;
    }

    function visibleLineCount() {
      let count = Math.min(maxVisible, allOptions.length);
      const { start, end } = getVisibleRange();
      if (useViewport && start > 0) count++;
      if (useViewport && end < allOptions.length) count++;
      return count;
    }

    // Track how many lines were rendered last time (for clearing)
    let lastRenderedLines = 0;

    function clearAndRender() {
      if (lastRenderedLines > 0) {
        process.stdout.write(`\x1b[${lastRenderedLines}A`);
        for (let i = 0; i < lastRenderedLines; i++) {
          process.stdout.write('\x1b[K\x1b[B');
        }
        process.stdout.write('\x1b[K');
        process.stdout.write(`\x1b[${lastRenderedLines}A`);
      }
      const lines = renderOptions();
      lastRenderedLines = lines.length;
      process.stdout.write(lines.join('\n') + '\n');
    }

    function cleanup() {
      _activeKeyHandler = null;
      _activeReject = null;
      _activeResolve = null;
      process.stdout.write(SHOW_CURSOR);
    }

    function selectOption(choice) {
      cleanup();
      if (choice.label === 'Other') {
        process.stdout.write(`${CYAN}Your answer: ${RESET}`);
        setupOtherInput(resolve);
      } else {
        console.log(`${DIM}Selected: ${choice.label}${RESET}`);
        resolve(choice.label);
      }
    }

    // Initial render
    console.log(`\n${CYAN}${BOLD}❓ ${question}${RESET}`);
    process.stdout.write(HIDE_CURSOR);
    const initialLines = renderOptions();
    lastRenderedLines = initialLines.length;
    process.stdout.write(initialLines.join('\n') + '\n');

    // Set the key handler — the main input loop will call this
    _activeKeyHandler = (key) => {
      // Arrow up / k
      if (key === '\x1b[A' || key === 'k') {
        selected = (selected - 1 + allOptions.length) % allOptions.length;
        clearAndRender();
      }
      // Arrow down / j
      else if (key === '\x1b[B' || key === 'j') {
        selected = (selected + 1) % allOptions.length;
        clearAndRender();
      }
      // Page Up
      else if (key === '\x1b[5~') {
        selected = Math.max(0, selected - maxVisible);
        clearAndRender();
      }
      // Page Down
      else if (key === '\x1b[6~') {
        selected = Math.min(allOptions.length - 1, selected + maxVisible);
        clearAndRender();
      }
      // Enter
      else if (key === '\r' || key === '\n') {
        selectOption(allOptions[selected]);
      }
      // Ctrl+C or Esc
      else if (key === '\x03' || key === '\x1b') {
        cleanup();
        resolve(null);
      }
      // Number keys for quick select (only when few options)
      else if (!useViewport) {
        const num = parseInt(key, 10);
        if (num >= 1 && num <= allOptions.length) {
          selected = num - 1;
          clearAndRender();
          selectOption(allOptions[selected]);
        }
      }
    };
  });
}

function setupOtherInput(resolve) {
  let buffer = '';

  _activeKeyHandler = (key) => {
    if (key === '\r' || key === '\n') {
      _activeKeyHandler = null;
      process.stdout.write('\n');
      resolve(buffer || null);
    } else if (key === '\x7f' || key === '\b') {
      if (buffer.length > 0) {
        buffer = buffer.slice(0, -1);
        process.stdout.write('\b \b');
      }
    } else if (key === '\x03' || key === '\x1b') {
      _activeKeyHandler = null;
      process.stdout.write('\n');
      resolve(null);
    } else if (key.charCodeAt(0) >= 32) {
      buffer += key;
      process.stdout.write(key);
    }
  };
}
