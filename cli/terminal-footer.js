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
    this.helpText = ' /help \u00b7 /share \u00b7 /auto \u00b7 \\+\u21b5 newline \u00b7 \u21b5 send';

    // Autocomplete state
    this._autocompleteItems = [];  // [{name, desc}]
    this._filteredItems = [];
    this._autocompleteVisible = false;
    this._maxAutocompleteRows = 5;

    this._setupDone = false;
  }

  // --- Autocomplete ---

  setAutocompleteItems(items) {
    this._autocompleteItems = items; // [{name, desc}]
  }

  _updateAutocomplete() {
    const buf = this.inputBuffer;
    // Show autocomplete only when input starts with "/" and is a single line
    if (!buf.startsWith('/') || buf.includes('\n') || buf.includes(' ')) {
      this._filteredItems = [];
      this._autocompleteVisible = false;
      return;
    }

    const query = buf.toLowerCase();
    this._filteredItems = this._autocompleteItems.filter(
      item => item.name.toLowerCase().startsWith(query)
    );
    this._autocompleteVisible = this._filteredItems.length > 0;
  }

  getTopMatch() {
    if (!this._autocompleteVisible || this._filteredItems.length === 0) return null;
    return this._filteredItems[0].name;
  }

  // --- Layout ---

  // Total footer height in terminal lines
  get _autocompleteRowCount() {
    if (!this._autocompleteVisible) return 0;
    return Math.min(this._filteredItems.length, this._maxAutocompleteRows);
  }

  get height() {
    // margin + top separator + input line(s) + autocomplete rows + bottom separator + help line
    return 1 + 1 + this._inputLineCount() + this._autocompleteRowCount + 1 + 1;
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
  get _autocompleteStartRow() { return this._bottomSepRow + 1; }
  get _helpRow()      { return this._autocompleteStartRow + this._autocompleteRowCount; }

  _inputLineCount() {
    // Count newlines in buffer for multi-line input
    const newlines = (this.inputBuffer.match(/\n/g) || []).length;
    return 1 + newlines;
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

    // Input line(s)
    const inputLines = this.inputBuffer.split('\n');
    for (let i = 0; i < this._inputLineCount(); i++) {
      process.stdout.write(`\x1b[${this._inputStartRow + i};1H\x1b[K`);
      if (this.inputActive) {
        const prefix = i === 0 ? `${BOLD}${this.inputPrompt}${RESET}` : `${DIM}… ${RESET}`;
        process.stdout.write(`${prefix}${inputLines[i] || ''}`);
      } else {
        if (i === 0) process.stdout.write(`${DIM}${this.inputPrompt}${RESET}`);
      }
    }

    // Bottom separator
    process.stdout.write(`\x1b[${this._bottomSepRow};1H\x1b[K`);
    process.stdout.write(`${DIM}${'─'.repeat(this.cols)}${RESET}`);

    // Autocomplete rows (below bottom separator)
    const acCount = this._autocompleteRowCount;
    for (let i = 0; i < acCount; i++) {
      const item = this._filteredItems[i];
      process.stdout.write(`\x1b[${this._autocompleteStartRow + i};1H\x1b[K`);
      const highlight = i === 0 ? BOLD : '';
      const nameColor = '\x1b[36m'; // cyan
      process.stdout.write(`  ${highlight}${nameColor}${item.name}${RESET}${highlight} ${DIM}${item.desc}${RESET}`);
    }

    // Help line
    process.stdout.write(`\x1b[${this._helpRow};1H\x1b[K`);
    process.stdout.write(`${DIM}${this.helpText}${RESET}`);
  }

  // Redraw input line(s) and reposition cursor
  redrawInput() {
    // Recalculate autocomplete state
    const oldAcCount = this._autocompleteRowCount;
    this._updateAutocomplete();
    const newAcCount = this._autocompleteRowCount;

    // Recalculate scroll region when line count or autocomplete count changes
    const oldHeight = this._lastLineCount || 1;
    const newHeight = this._inputLineCount();
    if (oldHeight !== newHeight || oldAcCount !== newAcCount) {
      this._lastLineCount = newHeight;
      // Clear entire old footer area before resizing (prevents ghost rows)
      const oldFooterHeight = 1 + 1 + oldHeight + oldAcCount + 1 + 1;
      const oldContentBottom = Math.max(1, this.rows - oldFooterHeight);
      for (let r = oldContentBottom + 1; r <= this.rows; r++) {
        process.stdout.write(`\x1b[${r};1H\x1b[K`);
      }
      // Scroll region needs to shrink/grow — redraw everything
      process.stdout.write(`\x1b[1;${this.contentBottom}r`);
      this.draw();
      this._positionInputCursor();
      return;
    }

    const inputLines = this.inputBuffer.split('\n');
    for (let i = 0; i < this._inputLineCount(); i++) {
      process.stdout.write(`\x1b[${this._inputStartRow + i};1H\x1b[K`);
      const prefix = i === 0 ? `${BOLD}${this.inputPrompt}${RESET}` : `${DIM}… ${RESET}`;
      process.stdout.write(`${prefix}${inputLines[i] || ''}`);
    }

    // Redraw autocomplete rows (content may have changed even if count didn't)
    const acCount = this._autocompleteRowCount;
    for (let i = 0; i < acCount; i++) {
      const item = this._filteredItems[i];
      process.stdout.write(`\x1b[${this._autocompleteStartRow + i};1H\x1b[K`);
      const highlight = i === 0 ? BOLD : '';
      const nameColor = '\x1b[36m';
      process.stdout.write(`  ${highlight}${nameColor}${item.name}${RESET}${highlight} ${DIM}${item.desc}${RESET}`);
    }

    this._positionInputCursor();
  }

  _positionInputCursor() {
    // Find which line and column the cursor is on
    const before = this.inputBuffer.substring(0, this.cursorPos);
    const lineIdx = (before.match(/\n/g) || []).length;
    const lastNewline = before.lastIndexOf('\n');
    const colInLine = lastNewline === -1 ? before.length : before.length - lastNewline - 1;
    const prefix = lineIdx === 0 ? this.inputPrompt.length : 2; // "… " is 2 chars
    const col = prefix + colInLine + 1;
    process.stdout.write(`\x1b[${this._inputStartRow + lineIdx};${col}H`);
  }

  // --- State transitions ---

  // Activate input: save content cursor, draw footer, position cursor in input
  activate(prompt = '> ') {
    this.inputPrompt = prompt;
    this.inputBuffer = '';
    this.cursorPos = 0;
    this.inputActive = true;
    this._lastLineCount = 1;
    this._filteredItems = [];
    this._autocompleteVisible = false;
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
    // Capture old footer bounds before shrinking
    const oldMarginRow = this._marginRow;
    const oldHelpRow = this._helpRow;
    this.inputBuffer = '';
    this.cursorPos = 0;
    this.inputActive = false;
    this._lastLineCount = 1;
    this._filteredItems = [];
    this._autocompleteVisible = false;
    // Clear entire old footer area (old top sep is above new margin row)
    for (let r = oldMarginRow; r <= oldHelpRow; r++) {
      process.stdout.write(`\x1b[${r};1H\x1b[K`);
    }
    // Restore scroll region for single-line footer, then redraw
    process.stdout.write(`\x1b[1;${this.contentBottom}r`);
    this.draw();
    // Restore content cursor AFTER draw so cursor ends up in content area
    process.stdout.write('\x1b8');
    return text;
  }
}
