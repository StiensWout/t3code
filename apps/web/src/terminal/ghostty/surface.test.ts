import { describe, expect, it } from "vite-plus/test";

import type { GhosttyCell, GhosttyRow } from "./core";
import { isTerminalCopyShortcut, terminalLinkAtColumn } from "./surface";

const cell = (text: string): GhosttyCell => ({
  text,
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

describe("terminalLinkAtColumn", () => {
  it("maps terminal cells to UTF-16 offsets after a wide emoji", () => {
    const cells = [
      cell("🙂"),
      cell(""),
      ...Array.from("https://t3.codes", (character) => cell(character)),
    ];
    const row: GhosttyRow = {
      cells,
      text: cells
        .map((value) => value.text || " ")
        .join("")
        .trimEnd(),
    };

    expect(terminalLinkAtColumn(row, 2)).toBe("https://t3.codes");
    expect(terminalLinkAtColumn(row, cells.length - 1)).toBe("https://t3.codes");
    expect(terminalLinkAtColumn(row, 0)).toBeNull();
  });
});

describe("isTerminalCopyShortcut", () => {
  const event = (overrides: Partial<Parameters<typeof isTerminalCopyShortcut>[0]> = {}) => ({
    ctrlKey: false,
    key: "c",
    metaKey: false,
    shiftKey: false,
    ...overrides,
  });

  it("keeps Ctrl+C available for SIGINT on macOS", () => {
    expect(isTerminalCopyShortcut(event({ ctrlKey: true }), "MacIntel")).toBe(false);
    expect(isTerminalCopyShortcut(event({ metaKey: true }), "MacIntel")).toBe(true);
  });

  it("uses the conventional Ctrl+Shift+C shortcut elsewhere", () => {
    expect(isTerminalCopyShortcut(event({ ctrlKey: true }), "Linux x86_64")).toBe(false);
    expect(isTerminalCopyShortcut(event({ ctrlKey: true, shiftKey: true }), "Linux x86_64")).toBe(
      true,
    );
  });

  it("uses the produced character instead of the physical key position", () => {
    expect(isTerminalCopyShortcut(event({ key: "C", metaKey: true }), "MacIntel")).toBe(true);
    expect(isTerminalCopyShortcut(event({ key: "j", metaKey: true }), "MacIntel")).toBe(false);
  });
});
