import { describe, expect, it } from "vite-plus/test";

import { clerkAppearance } from "./clerkAppearance";

describe("clerkAppearance", () => {
  it("maps colors without overriding Clerk's component structure", () => {
    expect(clerkAppearance).toEqual({
      variables: {
        colorPrimary: "var(--primary)",
        colorPrimaryForeground: "var(--primary-foreground)",
        colorDanger: "var(--error)",
        colorSuccess: "var(--success)",
        colorWarning: "var(--warning)",
        colorNeutral: "var(--foreground)",
        colorForeground: "var(--foreground)",
        colorMuted: "var(--muted)",
        colorMutedForeground: "var(--muted-foreground)",
        colorBackground: "var(--popover)",
        colorInputForeground: "var(--foreground)",
        colorInput: "var(--background)",
        colorRing: "var(--ring)",
        colorBorder: "var(--border)",
      },
    });
  });
});
