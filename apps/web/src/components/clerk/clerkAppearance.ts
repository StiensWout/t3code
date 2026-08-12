import type { ClerkProviderProps } from "@clerk/react";

/** Keeps Clerk's stock component structure while binding its color system to
 * the live T3 Code palette. CSS variables make theme changes propagate to
 * portaled sign-in and profile surfaces without remounting Clerk. */
export const clerkAppearance = {
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
} satisfies NonNullable<ClerkProviderProps["appearance"]>;
