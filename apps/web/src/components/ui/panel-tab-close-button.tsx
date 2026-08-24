import { X } from "lucide-react";
import type { ReactNode } from "react";

interface PanelTabCloseButtonProps {
  children: ReactNode;
  label: string;
  onClick: () => void;
}

/** Inside a `group/tab` row, swaps the tab identity for its close action on hover or focus. */
export function PanelTabCloseButton({ children, label, onClick }: PanelTabCloseButtonProps) {
  return (
    <button
      type="button"
      className="cursor-pointer group/close relative flex size-4 shrink-0 items-center justify-center rounded-sm hover:bg-muted"
      aria-label={label}
      onClick={onClick}
    >
      <span className="relative flex size-3 items-center justify-center group-hover/tab:hidden group-focus-visible/close:hidden">
        {children}
      </span>
      <X className="hidden size-3 group-hover/tab:block group-focus-visible/close:block" />
    </button>
  );
}
