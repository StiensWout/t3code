import { assert, describe, it } from "@effect/vitest";

import {
  EMPTY_PI_MODEL_CAPABILITIES,
  thinkingCapabilitiesForPiModel,
} from "./piThinkingCapabilities.ts";

describe("thinkingCapabilitiesForPiModel", () => {
  it("returns empty capabilities for a non-reasoning model", () => {
    assert.deepEqual(
      thinkingCapabilitiesForPiModel({ reasoning: false }),
      EMPTY_PI_MODEL_CAPABILITIES,
    );
  });

  it("maps Pi's per-model thinking levels into the picker", () => {
    const capabilities = thinkingCapabilitiesForPiModel({
      reasoning: true,
      thinkingLevelMap: { off: null, xhigh: "extra_high", max: null },
    });
    const descriptors = capabilities.optionDescriptors ?? [];
    const thinking = descriptors[0];
    assert.equal(thinking?.id, "thinking");
    assert.equal(thinking?.type, "select");
    if (thinking?.type !== "select") return;
    assert.deepEqual(
      thinking.options.map((option) => [option.id, option.label, option.isDefault === true]),
      [
        ["inherit", "Pi default", true],
        ["minimal", "Minimal", false],
        ["low", "Low", false],
        ["medium", "Medium", false],
        ["high", "High", false],
        ["xhigh", "Extra High", false],
      ],
    );
  });
});
