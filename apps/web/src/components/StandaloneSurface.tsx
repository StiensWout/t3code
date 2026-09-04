import type { ReactNode } from "react";

import { APP_DISPLAY_NAME, APP_STAGE_LABEL, APP_VERSION } from "../branding";
import { cn } from "../lib/utils";
import { resolveEnvironmentIdentificationPillLabel } from "./SidebarStageBackdrop";
import { T3CodeBrand } from "./T3Wordmark";
import { Badge } from "./ui/badge";

/**
 * Page frame for screens shown outside the app shell: pairing, CLI connect,
 * and the root error view. A narrow column centered on the plain app canvas,
 * the sidebar brand above it, the build version pinned to the bottom.
 */
export function StandaloneSurface({ children }: { readonly children: ReactNode }) {
  const stagePillLabel = resolveEnvironmentIdentificationPillLabel(APP_STAGE_LABEL);

  return (
    <div className="flex min-h-dvh flex-col bg-background px-5 text-foreground">
      <main className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center py-12">
        <div className="mb-6 flex h-7 items-center">
          <T3CodeBrand />
          {stagePillLabel ? (
            <Badge
              className="ml-1 rounded-full px-1.5 text-muted-foreground"
              size="sm"
              variant="secondary"
            >
              {stagePillLabel}
            </Badge>
          ) : null}
        </div>

        {children}
      </main>

      <p className="mx-auto w-full max-w-md pb-5 text-[11px] text-muted-foreground/60">
        {APP_DISPLAY_NAME} {APP_VERSION}
      </p>
    </div>
  );
}

/** Heading block shared by every standalone screen. */
export function StandaloneSurfaceHeading({
  eyebrow,
  title,
  description,
}: {
  readonly eyebrow?: string;
  readonly title: string;
  readonly description: ReactNode;
}) {
  return (
    <div className="mb-4">
      {eyebrow ? (
        <p className="mb-1.5 text-[11px] tracking-[0.04em] text-muted-foreground uppercase">
          {eyebrow}
        </p>
      ) : null}
      <h1 className="text-lg font-semibold tracking-tight">{title}</h1>
      <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">{description}</p>
    </div>
  );
}

/**
 * Grouped panel matching Settings sections. Direct children become rows
 * separated by hairlines; give each row its own padding.
 */
export function StandaloneSurfacePanel({
  className,
  children,
}: {
  readonly className?: string;
  readonly children: ReactNode;
}) {
  return (
    <div
      className={cn(
        "overflow-hidden rounded-xl border border-border/60 bg-card/40 shadow-xs/5 [&>*+*]:border-t [&>*+*]:border-border/50",
        className,
      )}
    >
      {children}
    </div>
  );
}
