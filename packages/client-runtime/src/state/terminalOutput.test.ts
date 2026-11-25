import { describe, expect, it } from "vite-plus/test";

import {
  appendOutput,
  EMPTY_TERMINAL_OUTPUT_STATE,
  INITIAL_TERMINAL_OUTPUT_CURSOR,
  readTerminalOutputUpdate,
  terminalOutputReplay,
} from "./terminalOutput.ts";

describe("terminal replay after local history trimming", () => {
  it.each(["before the line feed", "after the line feed"] as const)(
    "preserves a line feed when a renderer mounts %s",
    (mount) => {
      const budget = 8;
      const trimmed = appendOutput(EMPTY_TERMINAL_OUTPUT_STATE, "\u001b[123456789", budget);
      const withLineFeed = appendOutput(trimmed, "\n", budget);
      const initial = readTerminalOutputUpdate(
        mount === "before the line feed" ? trimmed : withLineFeed,
        INITIAL_TERMINAL_OUTPUT_CURSOR,
      );
      const lineFeed = readTerminalOutputUpdate(withLineFeed, initial.cursor);
      const completed = appendOutput(withLineFeed, "mX", budget);
      const final = readTerminalOutputUpdate(completed, lineFeed.cursor);

      expect(initial).toMatchObject({
        type: "reset",
        data: mount === "before the line feed" ? "" : "\n",
      });
      expect(lineFeed).toMatchObject(
        mount === "before the line feed" ? { type: "append", data: "\n" } : { type: "none" },
      );
      expect(final).toMatchObject({ type: "append", data: "X" });
      expect(terminalOutputReplay(completed)).toBe("\nX");
    },
  );
});
