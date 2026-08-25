import { assert, describe, it } from "@effect/vitest";

import { thinkingCapabilitiesForPiModel } from "./piThinkingCapabilities.ts";

describe("thinkingCapabilitiesForPiModel", () => {
  it("shows Pi's resolved default as the default choice while keeping it inherited", () => {
    const capabilities = thinkingCapabilitiesForPiModel(
      {
        reasoning: true,
        thinkingLevelMap: { off: null, xhigh: "extra_high", max: null },
      },
      "xhigh",
    );
    const descriptors = capabilities.optionDescriptors ?? [];
    const thinking = descriptors[0];
    assert.equal(thinking?.id, "thinking");
    assert.equal(thinking?.type, "select");
    if (thinking?.type !== "select") return;
    assert.deepEqual(
      thinking.options.map((option) => [option.id, option.label, option.isDefault === true]),
      [
        ["minimal", "Minimal", false],
        ["low", "Low", false],
        ["medium", "Medium", false],
        ["high", "High", false],
        ["inherit", "Extra High", true],
      ],
    );
  });
});
