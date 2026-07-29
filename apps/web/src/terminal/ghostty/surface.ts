import { isMacPlatform } from "../../lib/utils";
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
const linkPattern =
  /https?:\/\/[^\s"'<>]+|(?:\.{0,2}\/)?[\w@+.,-]+(?:\/[\w@+.,-]+)+(?::\d+(?::\d+)?)?/gu;

export function terminalLinkAtColumn(row: GhosttySnapshot["rowData"][number], column: number) {
  let offset = 0;
  for (let cellIndex = 0; cellIndex < column; cellIndex += 1) {
    offset += row.cells[cellIndex]?.text.length || 1;
  }
  for (const match of row.text.matchAll(linkPattern)) {
    const value = match[0];
    if (offset >= match.index && offset < match.index + value.length) return value;
  }
  return null;
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

export interface GhosttySelectionPosition {
  readonly start: { readonly x: number; readonly y: number };
  readonly end: { readonly x: number; readonly y: number };
}

export interface GhosttyTerminalSurfaceOptions {
  readonly theme: GhosttyTheme;
  readonly onData: (data: string) => void;
  readonly onResize: (cols: number, rows: number) => void;
  readonly onSelectionChange: () => void;
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
  private compositionCommitTimer: number | null = null;
  private cursorOn = true;
  private forceFullRender = true;
  private disposed = false;
  private selectionAnchor: { x: number; y: number } | null = null;
  private selectionEnd: { x: number; y: number } | null = null;
  private selectionAnchorScreen: { x: number; y: number } | null = null;
  private selectionEndScreen: { x: number; y: number } | null = null;
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
    if (this.compositionCommitTimer !== null) {
      window.clearTimeout(this.compositionCommitTimer);
    }
    this.removeEvents();
    this.core.dispose();
    if (this.canvas.parentElement === this.mount || this.input.parentElement === this.mount) {
      this.canvas.remove();
      this.input.remove();
    }
  }

  private readonly onKeyDown = (event: KeyboardEvent) => {
    if (!this.options.beforeKey(event)) return;
    if (isTerminalCopyShortcut(event) && this.hasSelection()) {
      event.preventDefault();
      void navigator.clipboard.writeText(this.getSelection());
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
    if (this.compositionCommitTimer !== null) {
      window.clearTimeout(this.compositionCommitTimer);
      this.compositionCommitTimer = null;
    }
    this.composing = true;
  };

  private readonly onCompositionEnd = (event: CompositionEvent) => {
    this.composing = false;
    const fallbackData = event.data;
    this.compositionCommitTimer = window.setTimeout(() => {
      this.compositionCommitTimer = null;
      const data = this.input.value || fallbackData;
      if (data.length > 0) this.options.onData(data);
      this.input.value = "";
    }, 0);
  };

  private readonly onInput = (event: Event) => {
    const inputEvent = event as InputEvent;
    if (this.composing || inputEvent.isComposing) return;
    if (this.compositionCommitTimer !== null) {
      window.clearTimeout(this.compositionCommitTimer);
      this.compositionCommitTimer = null;
    }
    const data = this.input.value || inputEvent.data || "";
    if (data.length > 0) this.options.onData(data);
    this.input.value = "";
  };

  private readonly onPointerDown = (event: PointerEvent) => {
    if (event.button !== 0) return;
    this.focus();
    const cell = this.cellAt(event.clientX, event.clientY);
    this.selectionAnchor = cell;
    this.selectionEnd = cell;
    this.selectionMoved = false;
    this.core.setSelection(cell.x, cell.y, cell.x, cell.y);
    this.selectionAnchorScreen = this.core.viewportPointToScreen(cell.x, cell.y);
    this.selectionEndScreen = this.selectionAnchorScreen;
    this.canvas.setPointerCapture(event.pointerId);
    this.requestRender();
  };

  private readonly onPointerMove = (event: PointerEvent) => {
    if (!this.selectionAnchor || !this.canvas.hasPointerCapture(event.pointerId)) return;
    const cell = this.cellAt(event.clientX, event.clientY);
    if (cell.x === this.selectionEnd?.x && cell.y === this.selectionEnd.y) return;
    this.selectionMoved = true;
    this.selectionEnd = cell;
    this.core.setSelection(this.selectionAnchor.x, this.selectionAnchor.y, cell.x, cell.y);
    this.selectionAnchorScreen = this.core.viewportPointToScreen(
      this.selectionAnchor.x,
      this.selectionAnchor.y,
    );
    this.selectionEndScreen = this.core.viewportPointToScreen(cell.x, cell.y);
    this.options.onSelectionChange();
    this.requestRender();
  };

  private readonly onPointerUp = (event: PointerEvent) => {
    if (this.canvas.hasPointerCapture(event.pointerId)) {
      this.canvas.releasePointerCapture(event.pointerId);
    }
    if (event.button !== 0) return;
    if (!this.selectionMoved && (event.metaKey || event.ctrlKey)) {
      const link = this.linkAt(event.clientX, event.clientY);
      if (link) this.options.onLinkActivate(link, event);
    } else if (!this.selectionMoved) {
      this.clearSelection();
    }
    this.options.onSelectionChange();
  };

  private readonly onWheel = (event: WheelEvent) => {
    if (event.deltaY === 0) return;
    event.preventDefault();
    const rows = Math.max(1, Math.round(Math.abs(event.deltaY) / this.metrics.height));
    this.core.scroll(event.deltaY < 0 ? -rows : rows);
    this.forceFullRender = true;
    this.requestRender();
  };

  private readonly onMouseDown = () => {
    this.focus();
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
    const row = this.snapshot.rowData[cell.y];
    if (!row) return null;
    return terminalLinkAtColumn(row, cell.x);
  }
}
