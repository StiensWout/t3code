import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";

import { parseInlineMarkdown } from "./composer-rich-text.ts";

for (const filename of ["__cafe\u0301__.py", "__مَلَف__.py"]) {
  NodeTest.test(`keeps the filename ${filename} literal beside emphasized text`, () => {
    NodeAssert.deepEqual(
      parseInlineMarkdown(`${filename} and __notes__`),
      [
        { text: `${filename} and `, marks: [] },
        { text: "notes", marks: ["bold"] },
      ],
      "expect filenames with combining marks to retain their underscores",
    );
  });
}
