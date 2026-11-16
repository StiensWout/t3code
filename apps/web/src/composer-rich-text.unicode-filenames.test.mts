import assert from "node:assert/strict";
import { test } from "node:test";

import { parseInlineMarkdown } from "./composer-rich-text.ts";

for (const filename of ["__café__.py", "__مَلَف__.py"]) {
  test(`keeps the filename ${filename} literal beside emphasized text`, () => {
    assert.deepEqual(
      parseInlineMarkdown(`${filename} and __notes__`),
      [
        { text: `${filename} and `, marks: [] },
        { text: "notes", marks: ["bold"] },
      ],
      "expect filenames with combining marks to retain their underscores",
    );
  });
}
