// Interactive select: arrow-key navigable option picker for terminal
// Mimics Claude CLI's question UI

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const CYAN = '\x1b[36m';
const HIDE_CURSOR = '\x1b[?25l';
const SHOW_CURSOR = '\x1b[?25h';

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
    const stdin = process.stdin;
    const wasRaw = stdin.isRaw;

    function renderOptions() {
      // Move cursor up to overwrite previous render (except first time)
      // We render: question line + option lines
      const lines = allOptions.map((opt, i) => {
        const pointer = i === selected ? `${CYAN}❯${RESET}` : ' ';
        const label = i === selected ? `${BOLD}${opt.label}${RESET}` : `${DIM}${opt.label}${RESET}`;
        const desc = opt.description ? ` ${DIM}— ${opt.description}${RESET}` : '';
        return `  ${pointer} ${label}${desc}`;
      });
      return lines.join('\n');
    }

    function clearAndRender() {
      // Clear previous option lines and rewrite
      process.stdout.write(`\x1b[${allOptions.length}A`); // move up
      process.stdout.write('\x1b[0J'); // clear from cursor to end
      process.stdout.write(renderOptions() + '\n');
    }

    // Initial render
    console.log(`\n${CYAN}${BOLD}❓ ${question}${RESET}`);
    process.stdout.write(HIDE_CURSOR);
    process.stdout.write(renderOptions() + '\n');

    stdin.setRawMode(true);
    stdin.resume();

    function cleanup() {
      stdin.removeListener('data', onKey);
      stdin.setRawMode(wasRaw || false);
      process.stdout.write(SHOW_CURSOR);
    }

    function onKey(data) {
      const key = data.toString();

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
        cleanup();
        const choice = allOptions[selected];

        if (choice.label === 'Other') {
          // Switch to text input mode
          process.stdout.write(`${CYAN}Your answer: ${RESET}`);
          handleOtherInput(resolve);
        } else {
          console.log(`${DIM}Selected: ${choice.label}${RESET}`);
          resolve(choice.label);
        }
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
          // Auto-confirm on number press
          cleanup();
          const choice = allOptions[selected];
          if (choice.label === 'Other') {
            process.stdout.write(`${CYAN}Your answer: ${RESET}`);
            handleOtherInput(resolve);
          } else {
            console.log(`${DIM}Selected: ${choice.label}${RESET}`);
            resolve(choice.label);
          }
        }
      }
    }

    stdin.on('data', onKey);
  });
}

function handleOtherInput(resolve) {
  const stdin = process.stdin;
  let buffer = '';

  stdin.setRawMode(true);
  stdin.resume();

  function onKey(data) {
    const key = data.toString();

    if (key === '\r' || key === '\n') {
      stdin.removeListener('data', onKey);
      stdin.setRawMode(false);
      process.stdout.write('\n');
      resolve(buffer || null);
    } else if (key === '\x7f' || key === '\b') {
      // Backspace
      if (buffer.length > 0) {
        buffer = buffer.slice(0, -1);
        process.stdout.write('\b \b');
      }
    } else if (key === '\x03') {
      // Ctrl+C
      stdin.removeListener('data', onKey);
      stdin.setRawMode(false);
      process.stdout.write('\n');
      resolve(null);
    } else if (key.charCodeAt(0) >= 32) {
      buffer += key;
      process.stdout.write(key);
    }
  }

  stdin.on('data', onKey);
}
