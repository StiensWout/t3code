import { isMacPlatform } from "../../lib/utils";
import { collectWrappedTerminalLinkLine, extractTerminalLinks } from "../../terminal-links";
import { GhosttyTerminalCore, type GhosttySnapshot, type GhosttyTheme } from "./core";
import {
  measureGhosttyCell,
  renderGhosttySnapshot,
  terminalGridSize,
  type GhosttyCellMetrics,
} from "./renderer";

const FONT_SIZE = 12;
const FONT_FAMILY =
  '"SF Mono", "SFMono-Regular", "JetBrains Mono", Consolas, "Liberation Mono", Menlo, monospace';
const CONTENT_PADDING = 4;
function terminalRowText(row: GhosttySnapshot["rowData"][number], trimRight: boolean): string {
  const text = row.cells.map((cell) => cell.text || " ").join("");
  return trimRight ? text.trimEnd() : text;
}

function terminalColumnOffset(row: GhosttySnapshot["rowData"][number], column: number): number {
  let offset = 0;
  for (let cellIndex = 0; cellIndex < column; cellIndex += 1) {
    offset += row.cells[cellIndex]?.text.length || 1;
  }
  return offset;
}

export function terminalLinkAtPosition(
  rows: GhosttySnapshot["rowData"],
  rowIndex: number,
  column: number,
): string | null {
  const wrappedLine = collectWrappedTerminalLinkLine(rowIndex + 1, (index) => {
    const row = rows[index];
    if (!row) return null;
    return {
      isWrapped: row.isWrapContinuation,
      translateToString: (trimRight = false) => terminalRowText(row, trimRight),
    };
  });
  if (!wrappedLine) return null;
  const segment = wrappedLine.segments.find((value) => value.bufferLineNumber === rowIndex + 1);
  const row = rows[rowIndex];
  if (!segment || !row) return null;
  const offset = segment.startIndex + terminalColumnOffset(row, column);
  for (const match of extractTerminalLinks(wrappedLine.text)) {
    if (offset >= match.start && offset < match.end) return match.text;
  }
  return null;
}

export function terminalLinkAtColumn(row: GhosttySnapshot["rowData"][number], column: number) {
  return terminalLinkAtPosition([row], 0, column);
}

export function isTerminalCopyShortcut(
  event: Pick<KeyboardEvent, "ctrlKey" | "key" | "metaKey" | "shiftKey">,
  platform = navigator.platform,
) {
  if (event.key.toLowerCase() !== "c") return false;
  return isMacPlatform(platform) ? event.metaKey : event.ctrlKey && event.shiftKey;
}

export function isTerminalPasteShortcut(
  event: Pick<KeyboardEvent, "ctrlKey" | "key" | "metaKey" | "shiftKey">,
  platform = navigator.platform,
) {
  if (event.key.toLowerCase() !== "v") return false;
  return isMacPlatform(platform) ? event.metaKey : event.ctrlKey && event.shiftKey;
}

export function isTerminalCompositionCommitInput(event: Pick<InputEvent, "inputType">): boolean {
  return (
    event.inputType === "" ||
    event.inputType === "insertCompositionText" ||
    event.inputType === "insertFromComposition"
  );
}

export function isTerminalAltGraphText(
  event: Pick<KeyboardEvent, "getModifierState" | "key">,
): boolean {
  return event.getModifierState("AltGraph") && [...event.key].length === 1;
}

export function shouldReportTerminalMouse(
  tracking: boolean,
  event: Pick<MouseEvent, "ctrlKey" | "metaKey" | "shiftKey">,
): boolean {
  return tracking && !event.shiftKey && !event.ctrlKey && !event.metaKey;
}

export function isTerminalLinkPointerGesture(
  event: Pick<MouseEvent, "ctrlKey" | "metaKey">,
  platform = navigator.platform,
): boolean {
  return isMacPlatform(platform)
    ? event.metaKey && !event.ctrlKey
    : event.ctrlKey && !event.metaKey;
}

export function ghosttyMouseButton(button: number): number | null {
  switch (button) {
    case 0:
      return 1;
    case 1:
      return 3;
    case 2:
      return 2;
    case 3:
      return 4;
    case 4:
      return 5;
    default:
      return null;
  }
}

export interface TerminalSelectionClickSequence {
  readonly count: number;
  readonly time: number;
  readonly x: number;
  readonly y: number;
}

export function advanceTerminalSelectionClickSequence(
  previous: TerminalSelectionClickSequence | null,
  event: Pick<PointerEvent, "clientX" | "clientY" | "timeStamp">,
): TerminalSelectionClickSequence {
  const repeats =
    previous !== null &&
    event.timeStamp - previous.time <= 500 &&
    Math.hypot(event.clientX - previous.x, event.clientY - previous.y) <= 4;
  return {
    count: repeats ? (previous.count >= 3 ? 1 : previous.count + 1) : 1,
    time: event.timeStamp,
    x: event.clientX,
    y: event.clientY,
  };
}

export interface GhosttySelectionPosition {
  readonly start: { readonly x: number; readonly y: number };
  readonly end: { readonly x: number; readonly y: number };
}

export interface GhosttyTerminalSurfaceOptions {
  readonly theme: GhosttyTheme;
  readonly onData: (data: string) => void;
  readonly onResize: (cols: number, rows: number) => void;
  readonly onSelectionChange: () => void;
  readonly onCopy: (text: string) => void;
  readonly beforeKey: (event: KeyboardEvent) => boolean;
  readonly onLinkActivate: (text: string, event: MouseEvent) => void;
}

export class GhosttyTerminalSurface {
  readonly canvas: HTMLCanvasElement;
  readonly input: HTMLTextAreaElement;
  cols = 1;
  rows = 1;

  private readonly mount: HTMLElement;
  private readonly context: CanvasRenderingContext2D;
  private readonly core: GhosttyTerminalCore;
  private readonly options: GhosttyTerminalSurfaceOptions;
  private readonly metrics: GhosttyCellMetrics;
  private readonly resizeObserver: ResizeObserver;
  private snapshot: GhosttySnapshot | null = null;
  private frame = 0;
  private cursorTimer: number | null = null;
  private compositionInputToSuppress: string | null = null;
  private compositionSuppressionTimer: number | null = null;
  private cursorOn = true;
  private forceFullRender = true;
  private disposed = false;
  private selectionAnchor: { x: number; y: number } | null = null;
  private selectionEnd: { x: number; y: number } | null = null;
  private selectionAnchorScreen: { x: number; y: number } | null = null;
  private selectionEndScreen: { x: number; y: number } | null = null;
  private selectionMode: "cell" | "word" | "line" = "cell";
  private selectionBase: {
    start: { x: number; y: number };
    end: { x: number; y: number };
  } | null = null;
  private mouseReportingPointerId: number | null = null;
  private mouseReportingButton: number | null = null;
  private linkActivationPointerId: number | null = null;
  private selectionClickSequence: TerminalSelectionClickSequence | null = null;
  private selectionMoved = false;
  private composing = false;

  private constructor(
    mount: HTMLElement,
    canvas: HTMLCanvasElement,
    input: HTMLTextAreaElement,
    context: CanvasRenderingContext2D,
    core: GhosttyTerminalCore,
    metrics: GhosttyCellMetrics,
    options: GhosttyTerminalSurfaceOptions,
  ) {
    this.mount = mount;
    this.canvas = canvas;
    this.input = input;
    this.context = context;
    this.core = core;
    this.metrics = metrics;
    this.options = options;
    this.resizeObserver = new ResizeObserver(() => this.fit());
    this.installEvents();
    this.resizeObserver.observe(mount);
  }

  static async create(
    mount: HTMLElement,
    options: GhosttyTerminalSurfaceOptions,
  ): Promise<GhosttyTerminalSurface> {
    const canvas = document.createElement("canvas");
    canvas.className = "t3-ghostty-canvas";
    canvas.style.cssText = "display:block;width:100%;height:100%;";
    canvas.setAttribute("aria-hidden", "true");

    const input = document.createElement("textarea");
    input.className = "t3-ghostty-input";
    input.setAttribute("aria-label", "Terminal input");
    input.autocapitalize = "off";
    input.autocomplete = "off";
    input.spellcheck = false;
    input.style.cssText =
      "position:absolute;left:4px;bottom:4px;width:1px;height:1px;opacity:0;padding:0;border:0;resize:none;";
    mount.replaceChildren(canvas, input);

    const context = canvas.getContext("2d", { alpha: false });
    if (!context) throw new Error("Canvas 2D is unavailable");
    const metrics = measureGhosttyCell(context, FONT_SIZE, FONT_FAMILY);
    const grid = terminalGridSize(mount.clientWidth, mount.clientHeight, metrics, CONTENT_PADDING);
    const core = await GhosttyTerminalCore.create(
      grid.cols,
      grid.rows,
      metrics.width,
      metrics.height,
      options.theme,
      options.onData,
    );
    const surface = new GhosttyTerminalSurface(
      mount,
      canvas,
      input,
      context,
      core,
      metrics,
      options,
    );
    surface.fit();
    surface.requestRender();
    return surface;
  }

  write(data: string): void {
    if (this.disposed) return;
    this.core.write(data);
    this.requestRender();
  }

  resetAndWrite(data: string): void {
    if (this.disposed) return;
    this.core.resetAndWrite(data);
    this.forceFullRender = true;
    this.requestRender();
  }

  setTheme(theme: GhosttyTheme): void {
    if (this.disposed) return;
    this.core.setTheme(theme);
    this.forceFullRender = true;
    this.requestRender();
  }

  fit(): boolean {
    if (this.disposed) return false;
    const width = this.mount.clientWidth;
    const height = this.mount.clientHeight;
    if (width <= 0 || height <= 0) return false;
    const ratio = window.devicePixelRatio || 1;
    const pixelWidth = Math.max(1, Math.round(width * ratio));
    const pixelHeight = Math.max(1, Math.round(height * ratio));
    let shouldRender = false;
    if (this.canvas.width !== pixelWidth || this.canvas.height !== pixelHeight) {
      this.canvas.width = pixelWidth;
      this.canvas.height = pixelHeight;
      this.context.setTransform(ratio, 0, 0, ratio, 0, 0);
      this.forceFullRender = true;
      shouldRender = true;
    }
    const grid = terminalGridSize(width, height, this.metrics, CONTENT_PADDING);
    if (grid.cols !== this.cols || grid.rows !== this.rows) {
      this.cols = grid.cols;
      this.rows = grid.rows;
      this.core.resize(grid.cols, grid.rows, this.metrics.width, this.metrics.height);
      this.options.onResize(grid.cols, grid.rows);
      this.forceFullRender = true;
      shouldRender = true;
    }
    if (shouldRender) this.requestRender();
    return true;
  }

  focus(): void {
    this.input.focus({ preventScroll: true });
  }

  hasSelection(): boolean {
    return this.core.selectionText().length > 0;
  }

  getSelection(): string {
    return this.core.selectionText();
  }

  getSelectionPosition(): GhosttySelectionPosition | null {
    if (!this.selectionAnchorScreen || !this.selectionEndScreen || !this.hasSelection())
      return null;
    const before =
      this.selectionAnchorScreen.y < this.selectionEndScreen.y ||
      (this.selectionAnchorScreen.y === this.selectionEndScreen.y &&
        this.selectionAnchorScreen.x <= this.selectionEndScreen.x);
    return before
      ? { start: this.selectionAnchorScreen, end: this.selectionEndScreen }
      : { start: this.selectionEndScreen, end: this.selectionAnchorScreen };
  }

  clearSelection(): void {
    this.core.clearSelection();
    this.selectionAnchor = null;
    this.selectionEnd = null;
    this.selectionAnchorScreen = null;
    this.selectionEndScreen = null;
    this.selectionMode = "cell";
    this.selectionBase = null;
    this.options.onSelectionChange();
    this.requestRender();
  }

  scrollToBottom(): void {
    this.core.scrollToBottom();
    this.forceFullRender = true;
    this.requestRender();
  }

  isAtBottom(): boolean {
    return this.core.isViewportActive();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.resizeObserver.disconnect();
    if (this.frame !== 0) window.cancelAnimationFrame(this.frame);
    if (this.cursorTimer !== null) window.clearTimeout(this.cursorTimer);
    if (this.compositionSuppressionTimer !== null) {
      window.clearTimeout(this.compositionSuppressionTimer);
    }
    this.removeEvents();
    this.core.dispose();
    if (this.canvas.parentElement === this.mount || this.input.parentElement === this.mount) {
      this.canvas.remove();
      this.input.remove();
    }
  }

  private readonly onKeyDown = (event: KeyboardEvent) => {
    if (isTerminalAltGraphText(event)) return;
    if (!this.options.beforeKey(event)) return;
    if (isTerminalCopyShortcut(event) && this.hasSelection()) {
      event.preventDefault();
      this.options.onCopy(this.getSelection());
      return;
    }
    if (isTerminalPasteShortcut(event)) return;
    if (event.isComposing || this.composing || event.key === "Process") return;
    const data = this.core.encodeKey(event);
    if (data.length === 0) return;
    event.preventDefault();
    event.stopPropagation();
    this.options.onData(data);
  };

  private readonly onPaste = (event: ClipboardEvent) => {
    const data = event.clipboardData?.getData("text/plain") ?? "";
    if (data.length === 0) return;
    event.preventDefault();
    this.options.onData(this.core.encodePaste(data));
  };

  private readonly onCompositionStart = () => {
    this.clearCompositionInputSuppression();
    this.composing = true;
  };

  private readonly onCompositionEnd = (event: CompositionEvent) => {
    this.composing = false;
    const data = this.input.value || event.data;
    if (data.length > 0) this.options.onData(data);
    this.input.value = "";
    this.compositionInputToSuppress = data;
    this.compositionSuppressionTimer = window.setTimeout(() => {
      this.compositionInputToSuppress = null;
      this.compositionSuppressionTimer = null;
    }, 100);
  };

  private readonly onInput = (event: Event) => {
    const inputEvent = event as InputEvent;
    if (this.composing || inputEvent.isComposing) return;
    const data = this.input.value || inputEvent.data || "";
    if (data === this.compositionInputToSuppress && isTerminalCompositionCommitInput(inputEvent)) {
      this.clearCompositionInputSuppression();
      this.input.value = "";
      return;
    }
    this.clearCompositionInputSuppression();
    if (data.length > 0) this.options.onData(data);
    this.input.value = "";
  };

  private clearCompositionInputSuppression(): void {
    if (this.compositionSuppressionTimer !== null) {
      window.clearTimeout(this.compositionSuppressionTimer);
      this.compositionSuppressionTimer = null;
    }
    this.compositionInputToSuppress = null;
  }

  private readonly onPointerDown = (event: PointerEvent) => {
    this.focus();
    if (shouldReportTerminalMouse(this.core.isMouseTracking(), event)) {
      const button = ghosttyMouseButton(event.button);
      if (button === null) return;
      event.preventDefault();
      event.stopPropagation();
      this.mouseReportingPointerId = event.pointerId;
      this.mouseReportingButton = button;
      this.sendMouse("press", button, event);
      this.canvas.setPointerCapture(event.pointerId);
      return;
    }
    if (event.button !== 0) return;
    if (isTerminalLinkPointerGesture(event)) {
      event.preventDefault();
      event.stopPropagation();
      this.linkActivationPointerId = event.pointerId;
      this.canvas.setPointerCapture(event.pointerId);
      return;
    }
    const cell = this.cellAt(event.clientX, event.clientY);
    this.selectionMoved = false;
    this.selectionClickSequence = advanceTerminalSelectionClickSequence(
      this.selectionClickSequence,
      event,
    );
    const clickCount = this.selectionClickSequence.count;
    this.selectionMode = clickCount >= 3 ? "line" : clickCount === 2 ? "word" : "cell";
    const range =
      this.selectionMode === "line"
        ? this.core.selectLine(cell.x, cell.y)
        : this.selectionMode === "word"
          ? this.core.selectWord(cell.x, cell.y)
          : null;
    if (range) {
      this.selectionBase = range.viewport;
      this.selectionAnchor = range.viewport.start;
      this.selectionEnd = range.viewport.end;
      this.selectionAnchorScreen = range.screen.start;
      this.selectionEndScreen = range.screen.end;
      this.options.onSelectionChange();
    } else {
      this.selectionMode = "cell";
      this.selectionBase = null;
      this.selectionAnchor = cell;
      this.selectionEnd = cell;
      this.core.setSelection(cell.x, cell.y, cell.x, cell.y);
      this.selectionAnchorScreen = this.core.viewportPointToScreen(cell.x, cell.y);
      this.selectionEndScreen = this.selectionAnchorScreen;
    }
    this.canvas.setPointerCapture(event.pointerId);
    this.requestRender();
  };

  private readonly onPointerMove = (event: PointerEvent) => {
    if (this.linkActivationPointerId === event.pointerId) return;
    if (
      this.mouseReportingPointerId === event.pointerId ||
      shouldReportTerminalMouse(this.core.isMouseTracking(), event)
    ) {
      event.preventDefault();
      this.canvas.style.cursor = "default";
      this.sendMouse("motion", this.buttonFromButtons(event.buttons), event);
      return;
    }
    if (!this.selectionAnchor || !this.canvas.hasPointerCapture(event.pointerId)) return;
    const cell = this.cellAt(event.clientX, event.clientY);
    if (cell.x === this.selectionEnd?.x && cell.y === this.selectionEnd.y) return;
    this.selectionMoved = true;
    const range =
      this.selectionMode === "line"
        ? this.core.selectLine(cell.x, cell.y)
        : this.selectionMode === "word"
          ? this.core.selectWord(cell.x, cell.y)
          : null;
    const base = this.selectionBase;
    const beforeBase =
      base !== null &&
      (cell.y < base.start.y || (cell.y === base.start.y && cell.x < base.start.x));
    const anchor = base === null ? this.selectionAnchor : beforeBase ? base.end : base.start;
    const end = range === null ? cell : beforeBase ? range.viewport.start : range.viewport.end;
    this.selectionAnchor = anchor;
    this.selectionEnd = end;
    this.core.setSelection(anchor.x, anchor.y, end.x, end.y);
    this.selectionAnchorScreen = this.core.viewportPointToScreen(anchor.x, anchor.y);
    this.selectionEndScreen = this.core.viewportPointToScreen(end.x, end.y);
    this.options.onSelectionChange();
    this.requestRender();
  };

  private readonly onPointerUp = (event: PointerEvent) => {
    if (this.linkActivationPointerId === event.pointerId) {
      event.preventDefault();
      event.stopPropagation();
      this.linkActivationPointerId = null;
      if (this.canvas.hasPointerCapture(event.pointerId)) {
        this.canvas.releasePointerCapture(event.pointerId);
      }
      if (event.type !== "pointercancel") {
        const link = this.linkAt(event.clientX, event.clientY);
        if (link) this.options.onLinkActivate(link, event);
      }
      return;
    }
    if (this.mouseReportingPointerId === event.pointerId) {
      event.preventDefault();
      event.stopPropagation();
      this.sendMouse("release", this.mouseReportingButton, event);
      this.mouseReportingPointerId = null;
      this.mouseReportingButton = null;
      if (this.canvas.hasPointerCapture(event.pointerId)) {
        this.canvas.releasePointerCapture(event.pointerId);
      }
      return;
    }
    if (this.canvas.hasPointerCapture(event.pointerId)) {
      this.canvas.releasePointerCapture(event.pointerId);
    }
    if (event.button !== 0) return;
    if (!this.selectionMoved && this.selectionMode === "cell") {
      this.clearSelection();
    }
    this.options.onSelectionChange();
  };

  private readonly onWheel = (event: WheelEvent) => {
    if (event.deltaY === 0) return;
    event.preventDefault();
    const rows = Math.max(1, Math.round(Math.abs(event.deltaY) / this.metrics.height));
    if (shouldReportTerminalMouse(this.core.isMouseTracking(), event)) {
      const button = event.deltaY < 0 ? 4 : 5;
      for (let index = 0; index < rows; index += 1) {
        this.sendMouse("press", button, event);
      }
      return;
    }
    this.core.scroll(event.deltaY < 0 ? -rows : rows);
    this.forceFullRender = true;
    this.requestRender();
  };

  private readonly onMouseDown = (event: MouseEvent) => {
    if (event.button === 0) event.preventDefault();
    this.focus();
  };

  private readonly onContextMenu = (event: MouseEvent) => {
    if (shouldReportTerminalMouse(this.core.isMouseTracking(), event)) {
      event.preventDefault();
    }
  };

  private installEvents(): void {
    this.input.addEventListener("keydown", this.onKeyDown);
    this.input.addEventListener("input", this.onInput);
    this.input.addEventListener("paste", this.onPaste);
    this.input.addEventListener("compositionstart", this.onCompositionStart);
    this.input.addEventListener("compositionend", this.onCompositionEnd);
    this.canvas.addEventListener("pointerdown", this.onPointerDown);
    this.canvas.addEventListener("pointermove", this.onPointerMove);
    this.canvas.addEventListener("pointerup", this.onPointerUp);
    this.canvas.addEventListener("pointercancel", this.onPointerUp);
    this.canvas.addEventListener("wheel", this.onWheel, { passive: false });
    this.canvas.addEventListener("mousedown", this.onMouseDown);
    this.canvas.addEventListener("contextmenu", this.onContextMenu);
  }

  private removeEvents(): void {
    this.input.removeEventListener("keydown", this.onKeyDown);
    this.input.removeEventListener("input", this.onInput);
    this.input.removeEventListener("paste", this.onPaste);
    this.input.removeEventListener("compositionstart", this.onCompositionStart);
    this.input.removeEventListener("compositionend", this.onCompositionEnd);
    this.canvas.removeEventListener("pointerdown", this.onPointerDown);
    this.canvas.removeEventListener("pointermove", this.onPointerMove);
    this.canvas.removeEventListener("pointerup", this.onPointerUp);
    this.canvas.removeEventListener("pointercancel", this.onPointerUp);
    this.canvas.removeEventListener("wheel", this.onWheel);
    this.canvas.removeEventListener("mousedown", this.onMouseDown);
    this.canvas.removeEventListener("contextmenu", this.onContextMenu);
  }

  private requestRender(): void {
    if (this.disposed || this.frame !== 0) return;
    this.frame = window.requestAnimationFrame(() => {
      this.frame = 0;
      this.snapshot = this.core.snapshot();
      if (!this.snapshot.cursorBlinking) this.cursorOn = true;
      renderGhosttySnapshot({
        context: this.context,
        snapshot: this.snapshot,
        metrics: this.metrics,
        fontSize: FONT_SIZE,
        fontFamily: FONT_FAMILY,
        padding: CONTENT_PADDING,
        forceFull: this.forceFullRender,
        cursorOn: this.cursorOn,
      });
      this.forceFullRender = false;
      this.scheduleCursorBlink();
    });
  }

  private scheduleCursorBlink(): void {
    if (this.cursorTimer !== null) window.clearTimeout(this.cursorTimer);
    this.cursorTimer = null;
    if (!this.snapshot?.cursorBlinking || !this.snapshot.cursorVisible) return;
    this.cursorTimer = window.setTimeout(() => {
      this.cursorTimer = null;
      this.cursorOn = !this.cursorOn;
      this.requestRender();
    }, 500);
  }

  private cellAt(clientX: number, clientY: number): { x: number; y: number } {
    const bounds = this.canvas.getBoundingClientRect();
    return {
      x: Math.max(
        0,
        Math.min(
          this.cols - 1,
          Math.floor((clientX - bounds.left - CONTENT_PADDING) / this.metrics.width),
        ),
      ),
      y: Math.max(
        0,
        Math.min(
          this.rows - 1,
          Math.floor((clientY - bounds.top - CONTENT_PADDING) / this.metrics.height),
        ),
      ),
    };
  }

  private linkAt(clientX: number, clientY: number): string | null {
    if (!this.snapshot) return null;
    const cell = this.cellAt(clientX, clientY);
    const explicitHyperlink = this.core.hyperlinkAt(cell.x, cell.y);
    if (explicitHyperlink) return explicitHyperlink;
    return terminalLinkAtPosition(this.snapshot.rowData, cell.y, cell.x);
  }

  private sendMouse(
    action: "press" | "release" | "motion",
    button: number | null,
    event: MouseEvent,
  ): void {
    const bounds = this.canvas.getBoundingClientRect();
    const data = this.core.encodeMouse({
      action,
      button,
      mods:
        (event.shiftKey ? 1 : 0) |
        (event.ctrlKey ? 1 << 1 : 0) |
        (event.altKey ? 1 << 2 : 0) |
        (event.metaKey ? 1 << 3 : 0),
      x: Math.max(0, event.clientX - bounds.left),
      y: Math.max(0, event.clientY - bounds.top),
      screenWidth: bounds.width,
      screenHeight: bounds.height,
      cellWidth: this.metrics.width,
      cellHeight: this.metrics.height,
      padding: CONTENT_PADDING,
      anyButtonPressed: event.buttons !== 0,
    });
    if (data.length > 0) this.options.onData(data);
  }

  private buttonFromButtons(buttons: number): number | null {
    if ((buttons & 1) !== 0) return 1;
    if ((buttons & 4) !== 0) return 3;
    if ((buttons & 2) !== 0) return 2;
    if ((buttons & 8) !== 0) return 4;
    if ((buttons & 16) !== 0) return 5;
    return null;
  }
}
