import { describe, expect, it } from "vite-plus/test";

import { ghosttyKeyForCode, ghosttyUnshiftedCodepoint } from "./keyCodes";

describe("ghosttyKeyForCode", () => {
  it("keeps the tail of the pinned Ghostty key enum in order", () => {
    expect(ghosttyKeyForCode("F25")).toBe(ghosttyKeyForCode("F24") + 1);
    expect(ghosttyKeyForCode("PrintScreen")).toBe(ghosttyKeyForCode("FnLock") + 1);
    expect(ghosttyKeyForCode("Pause")).toBe(ghosttyKeyForCode("ScrollLock") + 1);
    expect(ghosttyKeyForCode("Paste")).toBe(ghosttyKeyForCode("Cut") + 1);
  });
});

describe("ghosttyUnshiftedCodepoint", () => {
  it("provides the logical base character for Kitty keyboard encoding", () => {
    expect(ghosttyUnshiftedCodepoint({ code: "KeyC", key: "c" })).toBe("c".codePointAt(0));
    expect(ghosttyUnshiftedCodepoint({ code: "KeyC", key: "C" })).toBe("c".codePointAt(0));
    expect(ghosttyUnshiftedCodepoint({ code: "Digit1", key: "!" })).toBe("1".codePointAt(0));
    expect(ghosttyUnshiftedCodepoint({ code: "Slash", key: "?" })).toBe("/".codePointAt(0));
    expect(ghosttyUnshiftedCodepoint({ code: "Enter", key: "Enter" })).toBe(0);
  });

  it("prefers the active browser layout over US physical key positions", () => {
    const layoutMap = new Map([
      ["Digit1", "&"],
      ["KeyC", "j"],
    ]);
    expect(ghosttyUnshiftedCodepoint({ code: "Digit1", key: "1" }, layoutMap)).toBe(
      "&".codePointAt(0),
    );
    expect(ghosttyUnshiftedCodepoint({ code: "KeyC", key: "J" }, layoutMap)).toBe(
      "j".codePointAt(0),
    );
  });
});
