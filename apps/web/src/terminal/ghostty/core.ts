import { ghosttyKeyForCode } from "./keyCodes";
import { GhosttyRuntime, loadGhosttyRuntime } from "./runtime";

const GHOSTTY_SUCCESS = 0;
const MAX_SCROLLBACK_ROWS = 10_000;

const RENDER_DATA = {
  cols: 1,
  rows: 2,
  dirty: 3,
  rowIterator: 4,
  background: 5,
  foreground: 6,
  cursor: 7,
  cursorHasValue: 8,
  cursorStyle: 10,
  cursorVisible: 11,
  cursorBlinking: 12,
  cursorInViewport: 14,
  cursorX: 15,
  cursorY: 16,
} as const;

const ROW_DATA = {
  dirty: 1,
  cells: 3,
} as const;

const CELL_DATA = {
  style: 2,
  graphemesLength: 3,
  graphemes: 4,
  background: 5,
  foreground: 6,
  selected: 7,
} as const;

export interface GhosttyColor {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

export interface GhosttyTheme {
  readonly foreground: GhosttyColor;
  readonly background: GhosttyColor;
  readonly cursor: GhosttyColor;
}

export interface GhosttyCell {
  readonly text: string;
  readonly foreground: GhosttyColor;
  readonly background: GhosttyColor;
  readonly bold: boolean;
  readonly italic: boolean;
  readonly invisible: boolean;
  readonly strikethrough: boolean;
  readonly overline: boolean;
  readonly underline: boolean;
  readonly selected: boolean;
}

export interface GhosttyRow {
  readonly cells: readonly GhosttyCell[];
  readonly text: string;
}

export interface GhosttySnapshot {
  readonly cols: number;
  readonly rows: number;
  readonly foreground: GhosttyColor;
  readonly background: GhosttyColor;
  readonly cursor: GhosttyColor;
  readonly cursorX: number;
  readonly cursorY: number;
  readonly cursorVisible: boolean;
  readonly cursorBlinking: boolean;
  readonly cursorStyle: number;
  readonly dirtyRows: ReadonlySet<number>;
  readonly rowData: readonly GhosttyRow[];
}

const decoder = new TextDecoder();
const encoder = new TextEncoder();

function blend(foreground: GhosttyColor, background: GhosttyColor): GhosttyColor {
  const channel = (front: number, back: number) => Math.floor((front * 155 + back * 100) / 255);
  return {
    r: channel(foreground.r, background.r),
    g: channel(foreground.g, background.g),
    b: channel(foreground.b, background.b),
  };
}

function sameColor(left: GhosttyColor, right: GhosttyColor): boolean {
  return left.r === right.r && left.g === right.g && left.b === right.b;
}

export class GhosttyTerminalCore {
  private readonly runtime: GhosttyRuntime;
  private terminalSlot = 0;
  private terminal = 0;
  private renderStateSlot = 0;
  private renderState = 0;
  private rowIteratorSlot = 0;
  private rowCellsSlot = 0;
  private keyEncoderSlot = 0;
  private keyEncoder = 0;
  private keyEventSlot = 0;
  private keyEvent = 0;
  private ptyWriterId = 0;
  private scratch = 0;
  private style = 0;
  private rows: GhosttyRow[] = [];
  private disposed = false;

  private constructor(runtime: GhosttyRuntime) {
    this.runtime = runtime;
  }

  static async create(
    cols: number,
    rows: number,
    cellWidth: number,
    cellHeight: number,
    theme: GhosttyTheme,
    onPtyData: (data: string) => void,
  ): Promise<GhosttyTerminalCore> {
    const core = new GhosttyTerminalCore(await loadGhosttyRuntime());
    try {
      core.initialize(cols, rows, cellWidth, cellHeight, theme, onPtyData);
      return core;
    } catch (error) {
      core.dispose();
      throw error;
    }
  }

  private initialize(
    cols: number,
    rows: number,
    cellWidth: number,
    cellHeight: number,
    theme: GhosttyTheme,
    onPtyData: (data: string) => void,
  ): void {
    const optionsSize = this.runtime.layout("GhosttyTerminalOptions").size;
    const options = this.runtime.alloc(optionsSize);
    this.runtime.setField(options, "GhosttyTerminalOptions", "cols", cols);
    this.runtime.setField(options, "GhosttyTerminalOptions", "rows", rows);
    this.runtime.setField(options, "GhosttyTerminalOptions", "max_scrollback", MAX_SCROLLBACK_ROWS);
    this.terminalSlot = this.runtime.allocOpaque();
    this.assertSuccess(
      "ghostty_terminal_new",
      this.runtime.call("ghostty_terminal_new", 0, this.terminalSlot, options),
    );
    this.runtime.free(options, optionsSize);
    this.terminal = this.runtime.readPointer(this.terminalSlot);
    this.ptyWriterId = this.runtime.attachPtyWriter(this.terminal, onPtyData);

    this.renderStateSlot = this.runtime.allocOpaque();
    this.assertSuccess(
      "ghostty_render_state_new",
      this.runtime.call("ghostty_render_state_new", 0, this.renderStateSlot),
    );
    this.renderState = this.runtime.readPointer(this.renderStateSlot);

    this.rowIteratorSlot = this.runtime.allocOpaque();
    this.assertSuccess(
      "ghostty_render_state_row_iterator_new",
      this.runtime.call("ghostty_render_state_row_iterator_new", 0, this.rowIteratorSlot),
    );
    this.rowCellsSlot = this.runtime.allocOpaque();
    this.assertSuccess(
      "ghostty_render_state_row_cells_new",
      this.runtime.call("ghostty_render_state_row_cells_new", 0, this.rowCellsSlot),
    );

    this.keyEncoderSlot = this.runtime.allocOpaque();
    this.assertSuccess(
      "ghostty_key_encoder_new",
      this.runtime.call("ghostty_key_encoder_new", 0, this.keyEncoderSlot),
    );
    this.keyEncoder = this.runtime.readPointer(this.keyEncoderSlot);
    this.keyEventSlot = this.runtime.allocOpaque();
    this.assertSuccess(
      "ghostty_key_event_new",
      this.runtime.call("ghostty_key_event_new", 0, this.keyEventSlot),
    );
    this.keyEvent = this.runtime.readPointer(this.keyEventSlot);

    this.scratch = this.runtime.alloc(16);
    const styleSize = this.runtime.layout("GhosttyStyle").size;
    this.style = this.runtime.alloc(styleSize);
    this.runtime.setField(this.style, "GhosttyStyle", "size", styleSize);
    this.setTheme(theme);
    this.resize(cols, rows, cellWidth, cellHeight);
  }

  write(data: string | Uint8Array): void {
    this.ensureActive();
    const bytes = typeof data === "string" ? encoder.encode(data) : data;
    if (bytes.length === 0) return;
    const pointer = this.runtime.alloc(bytes.length);
    this.runtime.bytes(pointer, bytes.length).set(bytes);
    this.runtime.call("ghostty_terminal_vt_write", this.terminal, pointer, bytes.length);
    this.runtime.free(pointer, bytes.length);
  }

  resetAndWrite(data: string): void {
    this.ensureActive();
    this.runtime.call("ghostty_terminal_reset", this.terminal);
    this.rows = [];
    this.write(data);
  }

  resize(cols: number, rows: number, cellWidth: number, cellHeight: number): void {
    this.ensureActive();
    this.assertSuccess(
      "ghostty_terminal_resize",
      this.runtime.call(
        "ghostty_terminal_resize",
        this.terminal,
        Math.max(1, Math.min(65_535, cols)),
        Math.max(1, Math.min(65_535, rows)),
        Math.max(1, Math.round(cellWidth)),
        Math.max(1, Math.round(cellHeight)),
      ),
    );
  }

  setTheme(theme: GhosttyTheme): void {
    this.ensureActive();
    const color = this.runtime.alloc(3);
    for (const [option, value] of [
      [11, theme.foreground],
      [12, theme.background],
      [13, theme.cursor],
    ] as const) {
      this.runtime.bytes(color, 3).set([value.r, value.g, value.b]);
      this.runtime.call("ghostty_terminal_set", this.terminal, option, color);
    }
    this.runtime.free(color, 3);
  }

  scroll(deltaRows: number): void {
    this.ensureActive();
    const layout = this.runtime.layout("GhosttyTerminalScrollViewport");
    const scroll = this.runtime.alloc(layout.size);
    this.runtime.setField(scroll, "GhosttyTerminalScrollViewport", "tag", 2);
    const value = layout.fields.value!;
    this.runtime.view(scroll + value.offset, value.size).setInt32(0, deltaRows, true);
    this.runtime.call("ghostty_terminal_scroll_viewport", this.terminal, scroll);
    this.runtime.free(scroll, layout.size);
  }

  scrollToBottom(): void {
    this.ensureActive();
    const layout = this.runtime.layout("GhosttyTerminalScrollViewport");
    const scroll = this.runtime.alloc(layout.size);
    this.runtime.setField(scroll, "GhosttyTerminalScrollViewport", "tag", 1);
    this.runtime.call("ghostty_terminal_scroll_viewport", this.terminal, scroll);
    this.runtime.free(scroll, layout.size);
  }

  isViewportActive(): boolean {
    this.ensureActive();
    this.runtime.bytes(this.scratch, 1)[0] = 0;
    return (
      this.runtime.call("ghostty_terminal_get", this.terminal, 32, this.scratch) ===
        GHOSTTY_SUCCESS && this.runtime.bytes(this.scratch, 1)[0] !== 0
    );
  }

  encodeKey(event: KeyboardEvent): string {
    this.ensureActive();
    this.runtime.call("ghostty_key_encoder_setopt_from_terminal", this.keyEncoder, this.terminal);
    this.runtime.call("ghostty_key_event_set_action", this.keyEvent, event.repeat ? 2 : 1);
    this.runtime.call("ghostty_key_event_set_key", this.keyEvent, ghosttyKeyForCode(event.code));
    const mods =
      (event.shiftKey ? 1 : 0) |
      (event.ctrlKey ? 1 << 1 : 0) |
      (event.altKey ? 1 << 2 : 0) |
      (event.metaKey ? 1 << 3 : 0) |
      (event.getModifierState("CapsLock") ? 1 << 4 : 0) |
      (event.getModifierState("NumLock") ? 1 << 5 : 0);
    this.runtime.call("ghostty_key_event_set_mods", this.keyEvent, mods);
    this.runtime.call("ghostty_key_event_set_consumed_mods", this.keyEvent, 0);
    this.runtime.call("ghostty_key_event_set_composing", this.keyEvent, event.isComposing ? 1 : 0);

    const text = event.key.length === 1 ? event.key : "";
    const textBytes = encoder.encode(text);
    const textPointer = textBytes.length === 0 ? 0 : this.runtime.alloc(textBytes.length);
    if (textPointer !== 0) this.runtime.bytes(textPointer, textBytes.length).set(textBytes);
    this.runtime.call("ghostty_key_event_set_utf8", this.keyEvent, textPointer, textBytes.length);
    if (textPointer !== 0) this.runtime.free(textPointer, textBytes.length);

    const outputSize = 128;
    const output = this.runtime.alloc(outputSize);
    const written = this.runtime.call("ghostty_wasm_alloc_usize");
    const result = this.runtime.call(
      "ghostty_key_encoder_encode",
      this.keyEncoder,
      this.keyEvent,
      output,
      outputSize,
      written,
    );
    const length = this.runtime.view(written, 4).getUint32(0, true);
    const encoded =
      result === GHOSTTY_SUCCESS ? decoder.decode(this.runtime.bytes(output, length)) : "";
    this.runtime.call("ghostty_wasm_free_usize", written);
    this.runtime.free(output, outputSize);
    return encoded;
  }

  encodePaste(data: string): string {
    this.ensureActive();
    const input = encoder.encode(data);
    if (input.length === 0) return "";
    const inputPointer = this.runtime.alloc(input.length);
    this.runtime.bytes(inputPointer, input.length).set(input);
    this.runtime.bytes(this.scratch, 1)[0] = 0;
    const bracketed =
      this.runtime.call("ghostty_terminal_mode_get", this.terminal, 2004, this.scratch) ===
        GHOSTTY_SUCCESS && this.runtime.bytes(this.scratch, 1)[0] !== 0;
    const written = this.runtime.call("ghostty_wasm_alloc_usize");
    this.runtime.call(
      "ghostty_paste_encode",
      inputPointer,
      input.length,
      bracketed ? 1 : 0,
      0,
      0,
      written,
    );
    const outputSize = this.runtime.view(written, 4).getUint32(0, true);
    const output = this.runtime.alloc(Math.max(1, outputSize));
    const result = this.runtime.call(
      "ghostty_paste_encode",
      inputPointer,
      input.length,
      bracketed ? 1 : 0,
      output,
      outputSize,
      written,
    );
    const encoded =
      result === GHOSTTY_SUCCESS ? decoder.decode(this.runtime.bytes(output, outputSize)) : "";
    this.runtime.call("ghostty_wasm_free_usize", written);
    this.runtime.free(output, Math.max(1, outputSize));
    this.runtime.free(inputPointer, input.length);
    return encoded;
  }

  setSelection(anchorCol: number, anchorRow: number, col: number, row: number): void {
    this.ensureActive();
    const selectionLayout = this.runtime.layout("GhosttySelection");
    const selection = this.runtime.alloc(selectionLayout.size);
    this.runtime.setField(selection, "GhosttySelection", "size", selectionLayout.size);
    const start = this.gridRef(anchorCol, anchorRow);
    const end = this.gridRef(col, row);
    const startField = selectionLayout.fields.start!;
    const endField = selectionLayout.fields.end!;
    this.runtime
      .bytes(selection + startField.offset, startField.size)
      .set(this.runtime.bytes(start, startField.size));
    this.runtime
      .bytes(selection + endField.offset, endField.size)
      .set(this.runtime.bytes(end, endField.size));
    this.runtime.call("ghostty_terminal_set", this.terminal, 21, selection);
    this.runtime.free(start, this.runtime.layout("GhosttyGridRef").size);
    this.runtime.free(end, this.runtime.layout("GhosttyGridRef").size);
    this.runtime.free(selection, selectionLayout.size);
  }

  selectAll(): void {
    this.ensureActive();
    const layout = this.runtime.layout("GhosttySelection");
    const selection = this.runtime.alloc(layout.size);
    this.runtime.setField(selection, "GhosttySelection", "size", layout.size);
    if (
      this.runtime.call("ghostty_terminal_select_all", this.terminal, selection) === GHOSTTY_SUCCESS
    ) {
      this.runtime.call("ghostty_terminal_set", this.terminal, 21, selection);
    }
    this.runtime.free(selection, layout.size);
  }

  clearSelection(): void {
    this.ensureActive();
    this.runtime.call("ghostty_terminal_set", this.terminal, 21, 0);
  }

  snapshot(): GhosttySnapshot {
    this.ensureActive();
    this.assertSuccess(
      "ghostty_render_state_update",
      this.runtime.call("ghostty_render_state_update", this.renderState, this.terminal),
    );
    const cols = this.getU16(RENDER_DATA.cols);
    const rowCount = this.getU16(RENDER_DATA.rows);
    const dirty = this.getU32(RENDER_DATA.dirty);
    const foreground = this.getColor(RENDER_DATA.foreground, { r: 229, g: 231, b: 235 });
    const background = this.getColor(RENDER_DATA.background, { r: 0, g: 0, b: 0 });
    const cursorHasValue = this.getBool(RENDER_DATA.cursorHasValue);
    const cursor = cursorHasValue ? this.getColor(RENDER_DATA.cursor, foreground) : foreground;
    const cursorInViewport = this.getBool(RENDER_DATA.cursorInViewport);
    const cursorVisible = this.getBool(RENDER_DATA.cursorVisible) && cursorInViewport;
    const cursorX = cursorInViewport ? this.getU16(RENDER_DATA.cursorX) : -1;
    const cursorY = cursorInViewport ? this.getU16(RENDER_DATA.cursorY) : -1;

    if (this.rows.length !== rowCount || this.rows.some((row) => row.cells.length !== cols)) {
      this.rows = Array.from({ length: rowCount }, () => ({
        cells: Array.from({ length: cols }, () => this.emptyCell(foreground, background)),
        text: "",
      }));
    }

    const dirtyRows = new Set<number>();
    if (dirty !== 0) {
      this.assertSuccess(
        "ghostty_render_state_get(row iterator)",
        this.runtime.call(
          "ghostty_render_state_get",
          this.renderState,
          RENDER_DATA.rowIterator,
          this.rowIteratorSlot,
        ),
      );
      const iterator = this.runtime.readPointer(this.rowIteratorSlot);
      let rowIndex = 0;
      while (
        rowIndex < rowCount &&
        this.runtime.call("ghostty_render_state_row_iterator_next", iterator) !== 0
      ) {
        const rowDirty = dirty === 2 || this.getRowBool(iterator, ROW_DATA.dirty);
        if (rowDirty) {
          this.rows[rowIndex] = this.readRow(iterator, cols, foreground, background);
          dirtyRows.add(rowIndex);
          this.runtime.bytes(this.scratch, 1)[0] = 0;
          this.runtime.call("ghostty_render_state_row_set", iterator, 0, this.scratch);
        }
        rowIndex += 1;
      }
      this.runtime.view(this.scratch, 4).setUint32(0, 0, true);
      this.runtime.call("ghostty_render_state_set", this.renderState, 0, this.scratch);
    }

    return {
      cols,
      rows: rowCount,
      foreground,
      background,
      cursor,
      cursorX,
      cursorY,
      cursorVisible,
      cursorBlinking: this.getBool(RENDER_DATA.cursorBlinking),
      cursorStyle: this.getU32(RENDER_DATA.cursorStyle),
      dirtyRows,
      rowData: this.rows,
    };
  }

  selectionText(): string {
    const selectedLines = this.rows
      .map((row) =>
        row.cells
          .map((cell) => (cell.selected ? cell.text || " " : ""))
          .join("")
          .replace(/\s+$/u, ""),
      )
      .filter((line) => line.length > 0);
    return selectedLines.join("\n");
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.keyEvent) this.runtime.call("ghostty_key_event_free", this.keyEvent);
    if (this.keyEncoder) this.runtime.call("ghostty_key_encoder_free", this.keyEncoder);
    if (this.rowCellsSlot) {
      const cells = this.runtime.readPointer(this.rowCellsSlot);
      if (cells) this.runtime.call("ghostty_render_state_row_cells_free", cells);
    }
    if (this.rowIteratorSlot) {
      const iterator = this.runtime.readPointer(this.rowIteratorSlot);
      if (iterator) this.runtime.call("ghostty_render_state_row_iterator_free", iterator);
    }
    if (this.renderState) this.runtime.call("ghostty_render_state_free", this.renderState);
    if (this.terminal) {
      if (this.ptyWriterId) this.runtime.detachPtyWriter(this.terminal, this.ptyWriterId);
      this.runtime.call("ghostty_terminal_free", this.terminal);
    }
    if (this.style) this.runtime.free(this.style, this.runtime.layout("GhosttyStyle").size);
    if (this.scratch) this.runtime.free(this.scratch, 16);
    for (const slot of [
      this.keyEventSlot,
      this.keyEncoderSlot,
      this.rowCellsSlot,
      this.rowIteratorSlot,
      this.renderStateSlot,
      this.terminalSlot,
    ]) {
      this.runtime.freeOpaque(slot);
    }
  }

  private readRow(
    iterator: number,
    cols: number,
    defaultForeground: GhosttyColor,
    defaultBackground: GhosttyColor,
  ): GhosttyRow {
    this.assertSuccess(
      "ghostty_render_state_row_get(cells)",
      this.runtime.call(
        "ghostty_render_state_row_get",
        iterator,
        ROW_DATA.cells,
        this.rowCellsSlot,
      ),
    );
    const cellsIterator = this.runtime.readPointer(this.rowCellsSlot);
    const cells: GhosttyCell[] = [];
    while (
      cells.length < cols &&
      this.runtime.call("ghostty_render_state_row_cells_next", cellsIterator) !== 0
    ) {
      let foreground = this.getCellColor(cellsIterator, CELL_DATA.foreground, defaultForeground);
      let background = this.getCellColor(cellsIterator, CELL_DATA.background, defaultBackground);
      const styleSize = this.runtime.layout("GhosttyStyle").size;
      this.runtime.bytes(this.style, styleSize).fill(0);
      this.runtime.setField(this.style, "GhosttyStyle", "size", styleSize);
      this.runtime.call(
        "ghostty_render_state_row_cells_get",
        cellsIterator,
        CELL_DATA.style,
        this.style,
      );
      const inverse = this.runtime.readField(this.style, "GhosttyStyle", "inverse") !== 0;
      if (inverse) [foreground, background] = [background, foreground];
      if (this.runtime.readField(this.style, "GhosttyStyle", "faint") !== 0) {
        foreground = blend(foreground, background);
      }
      const graphemeLength = this.getCellU32(cellsIterator, CELL_DATA.graphemesLength);
      let text = "";
      if (graphemeLength > 0) {
        const bufferSize = graphemeLength * 4;
        const codepoints = this.runtime.alloc(bufferSize);
        if (
          this.runtime.call(
            "ghostty_render_state_row_cells_get",
            cellsIterator,
            CELL_DATA.graphemes,
            codepoints,
          ) === GHOSTTY_SUCCESS
        ) {
          text = String.fromCodePoint(
            ...new Uint32Array(this.runtime.memory.buffer, codepoints, graphemeLength),
          );
        }
        this.runtime.free(codepoints, bufferSize);
      }
      cells.push({
        text,
        foreground,
        background,
        bold: this.runtime.readField(this.style, "GhosttyStyle", "bold") !== 0,
        italic: this.runtime.readField(this.style, "GhosttyStyle", "italic") !== 0,
        invisible: this.runtime.readField(this.style, "GhosttyStyle", "invisible") !== 0,
        strikethrough: this.runtime.readField(this.style, "GhosttyStyle", "strikethrough") !== 0,
        overline: this.runtime.readField(this.style, "GhosttyStyle", "overline") !== 0,
        underline: this.runtime.readField(this.style, "GhosttyStyle", "underline") !== 0,
        selected: this.getCellBool(cellsIterator, CELL_DATA.selected),
      });
    }
    while (cells.length < cols) cells.push(this.emptyCell(defaultForeground, defaultBackground));
    return {
      cells,
      text: cells
        .map((cell) => cell.text || " ")
        .join("")
        .trimEnd(),
    };
  }

  private gridRef(col: number, row: number): number {
    const pointLayout = this.runtime.layout("GhosttyPoint");
    const point = this.runtime.alloc(pointLayout.size);
    this.runtime.setField(point, "GhosttyPoint", "tag", 1);
    const pointValue = pointLayout.fields.value!;
    const valueOffset = pointValue.offset;
    const view = this.runtime.view(point + valueOffset, pointValue.size);
    view.setUint16(0, Math.max(0, col), true);
    view.setUint32(4, Math.max(0, row), true);
    const gridRefSize = this.runtime.layout("GhosttyGridRef").size;
    const gridRef = this.runtime.alloc(gridRefSize);
    this.runtime.setField(gridRef, "GhosttyGridRef", "size", gridRefSize);
    this.assertSuccess(
      "ghostty_terminal_grid_ref",
      this.runtime.call("ghostty_terminal_grid_ref", this.terminal, point, gridRef),
    );
    this.runtime.free(point, pointLayout.size);
    return gridRef;
  }

  private getU16(data: number): number {
    this.runtime.bytes(this.scratch, 2).fill(0);
    this.assertSuccess(
      "ghostty_render_state_get",
      this.runtime.call("ghostty_render_state_get", this.renderState, data, this.scratch),
    );
    return this.runtime.view(this.scratch, 2).getUint16(0, true);
  }

  private getU32(data: number): number {
    this.runtime.bytes(this.scratch, 4).fill(0);
    this.assertSuccess(
      "ghostty_render_state_get",
      this.runtime.call("ghostty_render_state_get", this.renderState, data, this.scratch),
    );
    return this.runtime.view(this.scratch, 4).getUint32(0, true);
  }

  private getBool(data: number): boolean {
    this.runtime.bytes(this.scratch, 1)[0] = 0;
    this.assertSuccess(
      "ghostty_render_state_get",
      this.runtime.call("ghostty_render_state_get", this.renderState, data, this.scratch),
    );
    return this.runtime.bytes(this.scratch, 1)[0] !== 0;
  }

  private getColor(data: number, fallback: GhosttyColor): GhosttyColor {
    this.runtime.bytes(this.scratch, 3).fill(0);
    const result = this.runtime.call(
      "ghostty_render_state_get",
      this.renderState,
      data,
      this.scratch,
    );
    return result === GHOSTTY_SUCCESS ? this.readColor(this.scratch) : fallback;
  }

  private getRowBool(iterator: number, data: number): boolean {
    this.runtime.bytes(this.scratch, 1)[0] = 0;
    return (
      this.runtime.call("ghostty_render_state_row_get", iterator, data, this.scratch) ===
        GHOSTTY_SUCCESS && this.runtime.bytes(this.scratch, 1)[0] !== 0
    );
  }

  private getCellU32(iterator: number, data: number): number {
    this.runtime.bytes(this.scratch, 4).fill(0);
    const result = this.runtime.call(
      "ghostty_render_state_row_cells_get",
      iterator,
      data,
      this.scratch,
    );
    return result === GHOSTTY_SUCCESS ? this.runtime.view(this.scratch, 4).getUint32(0, true) : 0;
  }

  private getCellBool(iterator: number, data: number): boolean {
    this.runtime.bytes(this.scratch, 1)[0] = 0;
    return (
      this.runtime.call("ghostty_render_state_row_cells_get", iterator, data, this.scratch) ===
        GHOSTTY_SUCCESS && this.runtime.bytes(this.scratch, 1)[0] !== 0
    );
  }

  private getCellColor(iterator: number, data: number, fallback: GhosttyColor): GhosttyColor {
    this.runtime.bytes(this.scratch, 3).fill(0);
    const result = this.runtime.call(
      "ghostty_render_state_row_cells_get",
      iterator,
      data,
      this.scratch,
    );
    return result === GHOSTTY_SUCCESS ? this.readColor(this.scratch) : fallback;
  }

  private readColor(pointer: number): GhosttyColor {
    const bytes = this.runtime.bytes(pointer, 3);
    return { r: bytes[0] ?? 0, g: bytes[1] ?? 0, b: bytes[2] ?? 0 };
  }

  private emptyCell(foreground: GhosttyColor, background: GhosttyColor): GhosttyCell {
    return {
      text: "",
      foreground,
      background,
      bold: false,
      italic: false,
      invisible: false,
      strikethrough: false,
      overline: false,
      underline: false,
      selected: false,
    };
  }

  private assertSuccess(operation: string, result: number): void {
    if (result !== GHOSTTY_SUCCESS) throw new Error(`${operation} failed with result ${result}`);
  }

  private ensureActive(): void {
    if (this.disposed) throw new Error("libghostty-vt terminal has been disposed");
  }
}

export function ghosttyColorsEqual(left: GhosttyColor, right: GhosttyColor): boolean {
  return sameColor(left, right);
}
