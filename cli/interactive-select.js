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

/**
 * Show an interactive select menu with arrow key navigation.
 * @param {string} question - The question text
 * @param {{ label: string, description?: string }[]} options - Selectable options
 * @param {{ allowOther?: boolean }} opts
 * @returns {Promise<string>} - The selected option label, or typed text for "Other"
 */
export function interactiveSelect(question, options, opts = {}) {
  const allOptions = [...options];
  if (opts.allowOther !== false) {
    allOptions.push({ label: 'Other', description: 'Type your own answer' });
  }

  return new Promise((resolve) => {
    let selected = 0;

    function renderOptions() {
      const lines = allOptions.map((opt, i) => {
        const pointer = i === selected ? `${CYAN}❯${RESET}` : ' ';
        const label = i === selected ? `${BOLD}${opt.label}${RESET}` : `${DIM}${opt.label}${RESET}`;
        const desc = opt.description ? ` ${DIM}— ${opt.description}${RESET}` : '';
        return `  ${pointer} ${label}${desc}`;
      });
      return lines.join('\n');
    }

    function clearAndRender() {
      process.stdout.write(`\x1b[${allOptions.length}A`);
      // Clear each line individually (avoid \x1b[0J which would wipe the footer)
      for (let i = 0; i < allOptions.length; i++) {
        process.stdout.write('\x1b[K\x1b[B');
      }
      process.stdout.write('\x1b[K');
      process.stdout.write(`\x1b[${allOptions.length}A`);
      process.stdout.write(renderOptions() + '\n');
    }

    function cleanup() {
      _activeKeyHandler = null;
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
    process.stdout.write(renderOptions() + '\n');

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
      // Enter
      else if (key === '\r' || key === '\n') {
        selectOption(allOptions[selected]);
      }
      // Ctrl+C
      else if (key === '\x03') {
        cleanup();
        resolve(null);
      }
      // Number keys for quick select
      else {
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
    } else if (key === '\x03') {
      _activeKeyHandler = null;
      process.stdout.write('\n');
      resolve(null);
    } else if (key.charCodeAt(0) >= 32) {
      buffer += key;
      process.stdout.write(key);
    }
  };
}
