import { describe, expect, it } from "vite-plus/test";

import { GHOSTTY_CELL_WIDE, type GhosttyCell } from "./core";
import { ghosttyTextRunEnd, measureGhosttyCell, terminalGridSize } from "./renderer";

const cell = (text: string, wide = 0): GhosttyCell => ({
  text,
  wide,
  foreground: { r: 255, g: 255, b: 255 },
  background: { r: 0, g: 0, b: 0 },
  bold: false,
  italic: false,
  invisible: false,
  strikethrough: false,
  overline: false,
  underline: false,
  selected: false,
});

describe("terminalGridSize", () => {
  it("matches the mobile renderer's cell-and-padding sizing model", () => {
    expect(terminalGridSize(808, 408, { width: 10, height: 20, baseline: 15 }, 4)).toEqual({
      cols: 80,
      rows: 20,
    });
  });

  it("never sends an invalid zero-sized terminal to libghostty", () => {
    expect(terminalGridSize(0, 0, { width: 10, height: 20, baseline: 15 }, 4)).toEqual({
      cols: 1,
      rows: 1,
    });
  });
});

describe("measureGhosttyCell", () => {
  it("uses descender-aware metrics and the mobile terminal line-height", () => {
    const measureText = (text: string) =>
      text === "M"
        ? { width: 7.2, actualBoundingBoxAscent: 9, actualBoundingBoxDescent: 0 }
        : { width: 14.4, actualBoundingBoxAscent: 9, actualBoundingBoxDescent: 3 };
    const context = {
      font: "",
      measureText,
    } as unknown as CanvasRenderingContext2D;

    expect(measureGhosttyCell(context, 12, "monospace")).toEqual({
      width: 8,
      height: 16,
      baseline: 11,
    });
  });
});

describe("ghosttyTextRunEnd", () => {
  it("includes wide spacer tails in the visual clip without rendering spaces", () => {
    const cells = [
      cell("界", GHOSTTY_CELL_WIDE.wide),
      cell("", GHOSTTY_CELL_WIDE.spacerTail),
      cell("🙂", GHOSTTY_CELL_WIDE.wide),
      cell("", GHOSTTY_CELL_WIDE.spacerTail),
      cell(""),
    ];
    expect(ghosttyTextRunEnd(cells, 0, () => true)).toBe(4);
  });
});
