import type { ClerkProviderProps } from "@clerk/react";

/** Keeps Clerk's stock component structure while binding its color system to
 * the live T3 Code palette. CSS variables make theme changes propagate to
 * portaled sign-in and profile surfaces without remounting Clerk. */
export const clerkAppearance = {
  variables: {
    // Clerk reuses its primary color for filled buttons and bare links. The
    // app's update foreground is the palette's action hue cast for readable
    // text, while the card surface provides the inverse filled-control pair.
    colorPrimary: "var(--update-foreground)",
    colorPrimaryForeground: "var(--card)",
    // Clerk also renders status colors as inline text, so use the readable
    // foreground roles instead of the deeper fills used for icons and tinting.
    colorDanger: "var(--error-foreground)",
    colorSuccess: "var(--success-foreground)",
    colorWarning: "var(--warning-foreground)",
    colorNeutral: "var(--foreground)",
    colorForeground: "var(--foreground)",
    colorMuted: "var(--muted)",
    colorMutedForeground: "var(--muted-foreground)",
    colorBackground: "var(--card)",
    colorInputForeground: "var(--foreground)",
    colorInput: "var(--secondary)",
    colorRing: "var(--ring)",
  },
} satisfies NonNullable<ClerkProviderProps["appearance"]>;
