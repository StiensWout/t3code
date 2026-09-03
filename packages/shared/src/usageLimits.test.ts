import { describe, expect, it } from "vite-plus/test";

import * as DateTime from "effect/DateTime";

import { elapsedShare, formatDuration, paceOf } from "./usageLimits.ts";

const now = Date.parse("2026-09-03T12:00:00.000Z");
const weekly = (usedPercent: number, resetsInHours: number) => ({
  id: "seven_day",
  label: "Weekly",
  usedPercent,
  resetsAt: DateTime.formatIso(DateTime.makeUnsafe(now + resetsInHours * 3_600_000)),
  windowMinutes: 7 * 24 * 60,
});

describe("usage limit pace", () => {
  it("measures how far into the window we are", () => {
    // Resets in 84 hours of a 168 hour window: half elapsed.
    expect(elapsedShare(weekly(0, 84), now)).toBeCloseTo(0.5);
    expect(elapsedShare({ ...weekly(0, 84), windowMinutes: null }, now)).toBeNull();
    expect(elapsedShare({ ...weekly(0, 84), resetsAt: null }, now)).toBeNull();
  });

  it("compares usage against the clock with a five point band", () => {
    expect(paceOf(weekly(56, 84), now)).toBe("ahead");
    expect(paceOf(weekly(52, 84), now)).toBe("on");
    expect(paceOf(weekly(44, 84), now)).toBe("under");
    expect(paceOf({ ...weekly(44, 84), windowMinutes: null }, now)).toBeNull();
  });

  it("formats countdowns at the coarsest useful unit", () => {
    expect(formatDuration(3 * 86_400_000 + 4 * 3_600_000)).toBe("3d 4h");
    expect(formatDuration(2 * 3_600_000 + 13 * 60_000)).toBe("2h 13m");
    expect(formatDuration(12 * 60_000)).toBe("12m");
    expect(formatDuration(-5)).toBe("0m");
  });
});
