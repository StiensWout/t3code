import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import { ThemePreviewCircle, type ThemeCardPreviewColors } from "./ThemePreviewCircles";

const colors: ThemeCardPreviewColors = {
  sidebar: "#111111",
  canvas: "#222222",
  surface: "#333333",
  accentSurface: "#444444",
  accent: "#555555",
  messageSurface: "#666666",
  messageAction: "#777777",
};

describe("ThemePreviewCircle", () => {
  it("renders compact variant options from their palette without the full-size blur", () => {
    const markup = renderToStaticMarkup(<ThemePreviewCircle compact colors={colors} mode="dark" />);

    expect(markup).toContain("#111111");
    expect(markup).toContain("#222222");
    expect(markup).toContain("#555555");
    expect(markup).toContain("#666666");
    expect(markup).not.toContain("blur-[3px]");
  });

  it("keeps the regular theme preview treatment unchanged", () => {
    const markup = renderToStaticMarkup(<ThemePreviewCircle colors={colors} mode="dark" />);

    expect(markup).toContain("blur-[3px]");
    expect(markup).toContain("#777777");
  });
});
