import { expect, it } from "vite-plus/test";
import { markdownImageSources } from "./markdownImageSources";

it.each([
  {
    name: "full references in image order",
    markdown: "![Red][red]\n\n![Blue][blue]\n\n[blue]: ./blue.png\n[red]: ./red.png",
    expected: ["./red.png", "./blue.png"],
  },
  {
    name: "collapsed and shortcut references with the first matching definition",
    markdown:
      "![Red][]\n\n![Blue]\n\n> [RED]: ./red.png\n\n[red]: ./shadow.png\n[blue]: ./blue.png",
    expected: ["./red.png", "./blue.png"],
  },
  {
    name: "mixed embeds without duplicate images or non-image references",
    markdown: [
      "![One](one.png)",
      "![Two][two]",
      '<img src="three.png">',
      "![Again][two]",
      "[Link][link] ![Missing][missing]",
      "`![Literal][literal]`",
      "```md\n![Literal][literal]\n```",
      "[two]: two.png\n[link]: link.png\n[literal]: literal.png\n[unused]: unused.png",
    ].join("\n\n"),
    expected: ["one.png", "two.png", "three.png"],
  },
])("collects $name", ({ markdown, expected }) => {
  expect(markdownImageSources(markdown)).toEqual(expected);
});

it("collects a streaming image once its definition arrives", () => {
  const image = "![Red][red]";
  expect(markdownImageSources(image)).toEqual([]);
  expect(markdownImageSources(`${image}\n\n[red]: ./red.png`)).toEqual(["./red.png"]);
});
