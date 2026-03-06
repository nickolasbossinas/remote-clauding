// Terminal footer panel: fixed input area at the bottom of the terminal.
// Uses ANSI scroll regions to keep content above and footer below.
// Designed to be extensible — add status lines, info sections, etc.

const RESET = '\x1b[0m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';

export class TerminalFooter {
  constructor() {
    this.rows = process.stdout.rows || 24;
    this.cols = process.stdout.columns || 80;

    // Input state
    this.inputPrompt = '> ';
    this.inputBuffer = '';
    this.cursorPos = 0;
    this.inputActive = false;

    // Help hints (bottom of footer)
    this.helpText = ' /help \u00b7 /share \u00b7 /auto \u00b7 \u21b5 send';

    this._setupDone = false;
  }

  // --- Layout ---

  // Total footer height in terminal lines
  get height() {
    // margin + top separator + input line(s) + bottom separator + help line
    return 1 + 1 + this._inputLineCount() + 1 + 1;
  }

  // Last row of the content scroll region
  get contentBottom() {
    return Math.max(1, this.rows - this.height);
  }

  // Row numbers for each footer section
  get _marginRow()    { return this.contentBottom + 1; }
  get _topSepRow()    { return this.contentBottom + 2; }
  get _inputStartRow() { return this.contentBottom + 3; }
  get _bottomSepRow() { return this._inputStartRow + this._inputLineCount(); }
  get _helpRow()      { return this._bottomSepRow + 1; }

  _inputLineCount() {
    // Single line for now. Future: compute from buffer length + cols for wrapping.
    return 1;
  }

  // --- Setup & teardown ---

  setup() {
    this.rows = process.stdout.rows || 24;
    this.cols = process.stdout.columns || 80;

    // Scroll terminal up to make room for footer at the bottom.
    // If cursor is near the bottom, newlines push existing content up.
    for (let i = 0; i < this.height; i++) {
      process.stdout.write('\n');
    }
    // Move cursor back up past the blank lines we just created
    process.stdout.write(`\x1b[${this.height}A`);

    // Save content cursor BEFORE setting scroll region
    // (DECSTBM resets cursor to row 1 col 1, so we must save first)
    process.stdout.write('\x1b7');

    // Set scroll region (moves cursor to 1,1 — but we saved above)
    process.stdout.write(`\x1b[1;${this.contentBottom}r`);

    // Draw footer (uses absolute positioning, doesn't matter where cursor is)
    this.draw();

    // Restore content cursor to where it was before scroll region set
    process.stdout.write('\x1b8');

    this._setupDone = true;
    process.stdout.on('resize', () => this._onResize());
  }

  _onResize() {
    this.rows = process.stdout.rows || 24;
    this.cols = process.stdout.columns || 80;

    // Save cursor BEFORE scroll region change (DECSTBM resets cursor to 1,1)
    // When inputActive, content cursor is already saved from activate() — don't overwrite
    if (!this.inputActive) {
      process.stdout.write('\x1b7');
    }

    process.stdout.write(`\x1b[1;${this.contentBottom}r`);
    this.draw();

    if (this.inputActive) {
      this._positionInputCursor();
    } else {
      process.stdout.write('\x1b8');
    }
  }

  cleanup() {
    // Reset scroll region to full terminal
    process.stdout.write('\x1b[r');
    // Move cursor to bottom
    process.stdout.write(`\x1b[${this.rows};1H\n`);
  }

  // --- Drawing ---

  // Draw the entire footer panel (does NOT save/restore cursor — caller manages)
  draw() {
    // Blank margin above footer
    process.stdout.write(`\x1b[${this._marginRow};1H\x1b[K`);

    // Top separator
    process.stdout.write(`\x1b[${this._topSepRow};1H\x1b[K`);
    process.stdout.write(`${DIM}${'─'.repeat(this.cols)}${RESET}`);

    // Input line
    process.stdout.write(`\x1b[${this._inputStartRow};1H\x1b[K`);
    if (this.inputActive) {
      process.stdout.write(`${BOLD}${this.inputPrompt}${RESET}${this.inputBuffer}`);
    } else {
      process.stdout.write(`${DIM}${this.inputPrompt}${RESET}`);
    }

    // Bottom separator
    process.stdout.write(`\x1b[${this._bottomSepRow};1H\x1b[K`);
    process.stdout.write(`${DIM}${'─'.repeat(this.cols)}${RESET}`);

    // Help line
    process.stdout.write(`\x1b[${this._helpRow};1H\x1b[K`);
    process.stdout.write(`${DIM}${this.helpText}${RESET}`);
  }

  // Redraw just the input line and reposition cursor
  redrawInput() {
    process.stdout.write(`\x1b[${this._inputStartRow};1H\x1b[K`);
    process.stdout.write(`${BOLD}${this.inputPrompt}${RESET}${this.inputBuffer}`);
    this._positionInputCursor();
  }

  _positionInputCursor() {
    const col = this.inputPrompt.length + this.cursorPos + 1;
    process.stdout.write(`\x1b[${this._inputStartRow};${col}H`);
  }

  // --- State transitions ---

  // Activate input: save content cursor, draw footer, position cursor in input
  activate(prompt = '> ') {
    this.inputPrompt = prompt;
    this.inputBuffer = '';
    this.cursorPos = 0;
    this.inputActive = true;
    // Save content cursor position
    process.stdout.write('\x1b7');
    this.draw();
    this._positionInputCursor();
  }

  // Deactivate input: restore content cursor, redraw footer as inactive
  deactivate() {
    if (!this.inputActive) return;
    this.inputActive = false;
    this.draw();
    // Restore content cursor position
    process.stdout.write('\x1b8');
  }

  // Submit: capture input, restore content cursor, return text
  // Does NOT echo — caller decides whether/how to echo.
  submit() {
    const text = this.inputBuffer;
    this.inputBuffer = '';
    this.cursorPos = 0;
    this.inputActive = false;
    // Redraw footer as inactive (draw moves cursor to footer area)
    this.draw();
    // Restore content cursor AFTER draw so cursor ends up in content area
    process.stdout.write('\x1b8');
    return text;
  }
}
