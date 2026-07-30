import { describe, expect, it } from "vite-plus/test";

import type { GhosttyCell, GhosttyRow } from "./core";
import {
  advanceTerminalSelectionClickSequence,
  ghosttyMouseButton,
  isTerminalAltGraphText,
  isTerminalCompositionCommitInput,
  isTerminalCopyShortcut,
  isTerminalLinkPointerGesture,
  isTerminalPasteShortcut,
  shouldReportTerminalMouse,
  terminalLinkAtColumn,
  terminalLinkAtPosition,
} from "./surface";

const cell = (text: string): GhosttyCell => ({
  text,
  wide: 0,
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

describe("isTerminalAltGraphText", () => {
  it("defers printable AltGr output to the textarea input event", () => {
    expect(
      isTerminalAltGraphText({
        key: "@",
        getModifierState: (modifier) => modifier === "AltGraph",
      }),
    ).toBe(true);
    expect(
      isTerminalAltGraphText({
        key: "ArrowRight",
        getModifierState: (modifier) => modifier === "AltGraph",
      }),
    ).toBe(false);
  });
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
      isWrapContinuation: false,
    };

    expect(terminalLinkAtColumn(row, 2)).toBe("https://t3.codes");
    expect(terminalLinkAtColumn(row, cells.length - 1)).toBe("https://t3.codes");
    expect(terminalLinkAtColumn(row, 0)).toBeNull();
  });

  it("uses shared path matching and reconstructs soft-wrapped links", () => {
    const row = (text: string, isWrapContinuation: boolean): GhosttyRow => ({
      cells: Array.from(text.padEnd(16), (character) => cell(character)),
      text: text.trimEnd(),
      isWrapContinuation,
    });
    const rows = [
      row("https://example.", false),
      row("com/reference", true),
      row("~/project/file", false),
      row("C:\\repo\\file.ts", false),
    ];

    expect(terminalLinkAtPosition(rows, 0, 8)).toBe("https://example.com/reference");
    expect(terminalLinkAtPosition(rows, 1, 4)).toBe("https://example.com/reference");
    expect(terminalLinkAtPosition(rows, 2, 2)).toBe("~/project/file");
    expect(terminalLinkAtPosition(rows, 3, 4)).toBe("C:\\repo\\file.ts");
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

describe("isTerminalPasteShortcut", () => {
  const event = (overrides: Partial<Parameters<typeof isTerminalPasteShortcut>[0]> = {}) => ({
    ctrlKey: false,
    key: "v",
    metaKey: false,
    shiftKey: false,
    ...overrides,
  });

  it("uses Cmd+V on macOS", () => {
    expect(isTerminalPasteShortcut(event({ metaKey: true }), "MacIntel")).toBe(true);
    expect(isTerminalPasteShortcut(event({ ctrlKey: true }), "MacIntel")).toBe(false);
  });

  it("preserves Ctrl+V and uses Ctrl+Shift+V elsewhere", () => {
    expect(isTerminalPasteShortcut(event({ ctrlKey: true }), "Linux x86_64")).toBe(false);
    expect(isTerminalPasteShortcut(event({ ctrlKey: true, shiftKey: true }), "Linux x86_64")).toBe(
      true,
    );
  });
});

describe("isTerminalCompositionCommitInput", () => {
  it("identifies browser composition follow-up input", () => {
    expect(isTerminalCompositionCommitInput({ inputType: "" })).toBe(true);
    expect(isTerminalCompositionCommitInput({ inputType: "insertCompositionText" })).toBe(true);
    expect(isTerminalCompositionCommitInput({ inputType: "insertFromComposition" })).toBe(true);
  });

  it("keeps a fast repeated input as legitimate text", () => {
    expect(isTerminalCompositionCommitInput({ inputType: "insertText" })).toBe(false);
  });
});

describe("application mouse reporting", () => {
  const event = (overrides: Partial<Parameters<typeof shouldReportTerminalMouse>[1]> = {}) => ({
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    ...overrides,
  });

  it("keeps Shift and link activation modifiers available to the browser", () => {
    expect(shouldReportTerminalMouse(true, event())).toBe(true);
    expect(shouldReportTerminalMouse(true, event({ shiftKey: true }))).toBe(false);
    expect(shouldReportTerminalMouse(true, event({ ctrlKey: true }))).toBe(false);
    expect(shouldReportTerminalMouse(true, event({ metaKey: true }))).toBe(false);
    expect(shouldReportTerminalMouse(false, event())).toBe(false);
  });

  it("maps browser buttons to Ghostty's button enum", () => {
    expect([0, 1, 2, 3, 4, 5].map(ghosttyMouseButton)).toEqual([1, 3, 2, 4, 5, null]);
  });
});

describe("isTerminalLinkPointerGesture", () => {
  it("uses Command on macOS and Control elsewhere", () => {
    expect(isTerminalLinkPointerGesture({ ctrlKey: false, metaKey: true }, "MacIntel")).toBe(true);
    expect(isTerminalLinkPointerGesture({ ctrlKey: true, metaKey: false }, "MacIntel")).toBe(false);
    expect(isTerminalLinkPointerGesture({ ctrlKey: true, metaKey: false }, "Linux x86_64")).toBe(
      true,
    );
    expect(isTerminalLinkPointerGesture({ ctrlKey: false, metaKey: true }, "Linux x86_64")).toBe(
      false,
    );
  });
});

describe("advanceTerminalSelectionClickSequence", () => {
  it("recognizes stationary double and triple pointer presses without PointerEvent.detail", () => {
    const first = advanceTerminalSelectionClickSequence(null, {
      clientX: 20,
      clientY: 30,
      timeStamp: 1_000,
    });
    const second = advanceTerminalSelectionClickSequence(first, {
      clientX: 22,
      clientY: 29,
      timeStamp: 1_200,
    });
    const third = advanceTerminalSelectionClickSequence(second, {
      clientX: 21,
      clientY: 31,
      timeStamp: 1_400,
    });

    expect([first.count, second.count, third.count]).toEqual([1, 2, 3]);
  });

  it("starts over after movement, delay, or a completed triple click", () => {
    const previous = { count: 3, time: 1_000, x: 20, y: 30 };
    expect(
      advanceTerminalSelectionClickSequence(previous, {
        clientX: 20,
        clientY: 30,
        timeStamp: 1_100,
      }).count,
    ).toBe(1);
    expect(
      advanceTerminalSelectionClickSequence(previous, {
        clientX: 30,
        clientY: 30,
        timeStamp: 1_100,
      }).count,
    ).toBe(1);
    expect(
      advanceTerminalSelectionClickSequence(previous, {
        clientX: 20,
        clientY: 30,
        timeStamp: 1_501,
      }).count,
    ).toBe(1);
  });
});
