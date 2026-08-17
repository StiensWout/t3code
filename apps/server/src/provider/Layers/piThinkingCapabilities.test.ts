import { assert, describe, it } from "@effect/vitest";

import {
  EMPTY_PI_MODEL_CAPABILITIES,
  supportedPiThinkingLevelsFromModel,
  thinkingCapabilitiesForPiModel,
} from "./piThinkingCapabilities.ts";

describe("supportedPiThinkingLevelsFromModel", () => {
  it("returns no levels when the model does not advertise reasoning", () => {
    assert.deepEqual(supportedPiThinkingLevelsFromModel({ reasoning: false }), []);
    assert.deepEqual(supportedPiThinkingLevelsFromModel({}), []);
  });

  it("advertises off through high without Extra High or Max when the map is absent", () => {
    assert.deepEqual(supportedPiThinkingLevelsFromModel({ reasoning: true }), [
      "off",
      "minimal",
      "low",
      "medium",
      "high",
    ]);
  });

  it("adds Extra High and Max only when the map has a non-null entry", () => {
    assert.deepEqual(
      supportedPiThinkingLevelsFromModel({
        reasoning: true,
        thinkingLevelMap: { xhigh: "xhigh", max: "max" },
      }),
      ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
    );
  });

  it("hides a mapped-null level and keeps Extra High when only that entry exists", () => {
    assert.deepEqual(
      supportedPiThinkingLevelsFromModel({
        reasoning: true,
        thinkingLevelMap: { off: null, xhigh: "extra_high" },
      }),
      ["minimal", "low", "medium", "high", "xhigh"],
    );
  });

  it("does not treat a null Extra High or Max entry as supported", () => {
    assert.deepEqual(
      supportedPiThinkingLevelsFromModel({
        reasoning: true,
        thinkingLevelMap: { xhigh: null, max: null },
      }),
      ["off", "minimal", "low", "medium", "high"],
    );
  });
});

describe("thinkingCapabilitiesForPiModel", () => {
  it("returns empty capabilities for a non-reasoning model", () => {
    assert.deepEqual(
      thinkingCapabilitiesForPiModel({ reasoning: false }),
      EMPTY_PI_MODEL_CAPABILITIES,
    );
  });

  it("prepends inherit and labels Extra High for grok-4.6-shaped maps", () => {
    const capabilities = thinkingCapabilitiesForPiModel({
      reasoning: true,
      thinkingLevelMap: { xhigh: "xhigh" },
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
        ["off", "Off", false],
        ["minimal", "Minimal", false],
        ["low", "Low", false],
        ["medium", "Medium", false],
        ["high", "High", false],
        ["xhigh", "Extra High", false],
      ],
    );
  });
});
