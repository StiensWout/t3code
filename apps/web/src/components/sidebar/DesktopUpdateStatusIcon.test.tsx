import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import {
  DesktopUpdateStatusIcon,
  normalizeDesktopUpdateDownloadPercent,
  shouldContinueDesktopUpdateCheckAnimation,
  shouldShowDesktopUpdateCheckIcon,
} from "./DesktopUpdateStatusIcon";

describe("DesktopUpdateStatusIcon", () => {
  it("keeps a completed fast check visible until the current rotation ends", () => {
    expect(
      shouldShowDesktopUpdateCheckIcon({
        isAnimationLatched: true,
        isChecking: false,
        prefersReducedMotion: false,
      }),
    ).toBe(true);
    expect(
      shouldContinueDesktopUpdateCheckAnimation({
        isChecking: false,
        prefersReducedMotion: false,
      }),
    ).toBe(false);
  });

  it("continues whole rotations while the update check remains active", () => {
    expect(
      shouldContinueDesktopUpdateCheckAnimation({
        isChecking: true,
        prefersReducedMotion: false,
      }),
    ).toBe(true);
  });

  it("does not latch checking motion when reduced motion is preferred", () => {
    expect(
      shouldShowDesktopUpdateCheckIcon({
        isAnimationLatched: true,
        isChecking: false,
        prefersReducedMotion: true,
      }),
    ).toBe(false);
    expect(
      shouldContinueDesktopUpdateCheckAnimation({
        isChecking: true,
        prefersReducedMotion: true,
      }),
    ).toBe(false);
  });

  it("renders active checking motion only for the checking state", () => {
    const checking = renderToStaticMarkup(
      <DesktopUpdateStatusIcon status="checking" isCheckAnimating />,
    );
    const idle = renderToStaticMarkup(<DesktopUpdateStatusIcon status="idle" isCheckAnimating />);

    expect(checking).toContain("animate-spin");
    expect(idle).not.toContain("animate-spin");
  });

  it("renders determinate download progress and clamps invalid percentages", () => {
    expect(normalizeDesktopUpdateDownloadPercent(-10)).toBe(0);
    expect(normalizeDesktopUpdateDownloadPercent(62.5)).toBe(62.5);
    expect(normalizeDesktopUpdateDownloadPercent(120)).toBe(100);
    expect(normalizeDesktopUpdateDownloadPercent(Number.NaN)).toBe(0);

    const markup = renderToStaticMarkup(
      <DesktopUpdateStatusIcon status="downloading" downloadPercent={62.5} />,
    );
    expect(markup).toContain("stroke-dasharray");
    expect(markup).toContain("stroke-dashoffset");
  });

  it("distinguishes ready-to-download and downloaded states", () => {
    const available = renderToStaticMarkup(<DesktopUpdateStatusIcon status="available" />);
    const downloaded = renderToStaticMarkup(<DesktopUpdateStatusIcon status="downloaded" />);

    expect(available).toContain("lucide-download");
    expect(available).not.toContain("lucide-check");
    expect(downloaded).toContain("lucide-rotate-cw");
    expect(downloaded).toContain("lucide-check");
  });
});
