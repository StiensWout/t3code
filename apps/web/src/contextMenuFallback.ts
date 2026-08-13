import type { ContextMenuItem } from "@t3tools/contracts";

const SVG_NS = "http://www.w3.org/2000/svg";

// Inline Lucide-style icon paths (stroke-based, viewBox 0 0 24 24, strokeWidth 2).
const ICON_PATHS: Record<string, ReadonlyArray<{ tag: string; attrs: Record<string, string> }>> = {
  pencil: [
    {
      tag: "path",
      attrs: {
        d: "M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z",
      },
    },
    { tag: "path", attrs: { d: "m15 5 4 4" } },
  ],
  copy: [
    { tag: "rect", attrs: { width: "14", height: "14", x: "8", y: "8", rx: "2", ry: "2" } },
    { tag: "path", attrs: { d: "M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" } },
  ],
  "folder-tree": [
    {
      tag: "path",
      attrs: {
        d: "M20 10a1 1 0 0 0 1-1V6a1 1 0 0 0-1-1h-2.5a1 1 0 0 1-.8-.4l-.9-1.2A1 1 0 0 0 15 3h-2a1 1 0 0 0-1 1v5a1 1 0 0 0 1 1Z",
      },
    },
    {
      tag: "path",
      attrs: {
        d: "M20 21a1 1 0 0 0 1-1v-3a1 1 0 0 0-1-1h-2.9a1 1 0 0 1-.88-.55l-.42-.85a1 1 0 0 0-.92-.6H13a1 1 0 0 0-1 1v5a1 1 0 0 0 1 1Z",
      },
    },
    { tag: "path", attrs: { d: "M3 5a2 2 0 0 0 2 2h3" } },
    { tag: "path", attrs: { d: "M3 3v13a2 2 0 0 0 2 2h3" } },
  ],
  trash: [
    { tag: "path", attrs: { d: "M3 6h18" } },
    { tag: "path", attrs: { d: "M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" } },
    { tag: "path", attrs: { d: "M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" } },
    { tag: "line", attrs: { x1: "10", x2: "10", y1: "11", y2: "17" } },
    { tag: "line", attrs: { x1: "14", x2: "14", y1: "11", y2: "17" } },
  ],
};

function createIconElement(name: string, tone: "neutral" | "destructive"): SVGSVGElement | null {
  const paths = ICON_PATHS[name];
  if (!paths) {
    return null;
  }
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("xmlns", SVG_NS);
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute(
    "class",
    tone === "destructive" ? "size-3.5 shrink-0" : "size-3.5 shrink-0 text-muted-foreground",
  );
  for (const node of paths) {
    const child = document.createElementNS(SVG_NS, node.tag);
    for (const [key, value] of Object.entries(node.attrs)) {
      child.setAttribute(key, value);
    }
    svg.appendChild(child);
  }
  return svg;
}

function clampMenuPosition(menu: HTMLDivElement, preferredLeft: number, preferredTop: number) {
  const rect = menu.getBoundingClientRect();
  const left = Math.min(
    Math.max(4, preferredLeft),
    Math.max(4, window.innerWidth - rect.width - 4),
  );
  const top = Math.min(
    Math.max(4, preferredTop),
    Math.max(4, window.innerHeight - rect.height - 4),
  );
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
}

function isNodeWithinMenuStack(target: EventTarget | null, menuStack: readonly HTMLDivElement[]) {
  if (typeof Node !== "undefined" && target instanceof Node) {
    return menuStack.some((menu) => menu.contains(target));
  }
  if (!target || typeof target !== "object") {
    return false;
  }

  let current: unknown = target;
  while (current && typeof current === "object") {
    if (menuStack.includes(current as HTMLDivElement)) {
      return true;
    }
    current = (current as { parent?: unknown }).parent;
  }
  return false;
}

/**
 * Imperative DOM-based context menu for non-Electron environments.
 * Supports keyboard and pointer navigation through nested submenus and resolves
 * with the selected leaf item id.
 */
export function showContextMenuFallback<T extends string>(
  items: readonly ContextMenuItem<T>[],
  position?: { x: number; y: number },
): Promise<T | null> {
  return new Promise<T | null>((resolve) => {
    const menuStack: HTMLDivElement[] = [];
    const menuParentButtons: Array<HTMLButtonElement | null> = [];
    const buttonMetadata = new WeakMap<
      HTMLButtonElement,
      {
        readonly item: ContextMenuItem<T>;
        readonly openSubmenu: (focusFirstItem: boolean) => void;
      }
    >();
    let isDisposed = false;
    let canDismissFromPointer = false;

    const cleanup = (result: T | null) => {
      if (isDisposed) {
        return;
      }
      isDisposed = true;
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("contextmenu", onContextMenu, true);
      for (const menu of menuStack) {
        menu.remove();
      }
      resolve(result);
    };

    const closeMenusFromLevel = (level: number) => {
      while (menuStack.length > level) {
        const childLevel = menuStack.length - 1;
        menuParentButtons[childLevel]?.setAttribute("aria-expanded", "false");
        menuParentButtons.pop();
        menuStack.pop()?.remove();
      }
    };

    const getEnabledMenuButtons = (menu: HTMLDivElement): HTMLButtonElement[] =>
      Array.from(menu.querySelectorAll<HTMLButtonElement>("button")).filter(
        (button) => !button.disabled,
      );

    const focusMenuItem = (menu: HTMLDivElement, index: number) => {
      const buttons = getEnabledMenuButtons(menu);
      if (buttons.length === 0) {
        return;
      }
      const normalizedIndex = (index + buttons.length) % buttons.length;
      const button = buttons[normalizedIndex];
      if (!button) {
        return;
      }
      button.focus();
      button.scrollIntoView?.({ block: "nearest" });
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        cleanup(null);
        return;
      }

      const eventTarget = event.target ?? document.activeElement;
      const menuIndex = menuStack.findIndex((menu) => isNodeWithinMenuStack(eventTarget, [menu]));
      const menu = menuStack[menuIndex];
      if (!menu) {
        return;
      }

      const buttons = getEnabledMenuButtons(menu);
      const button = buttons.find((candidate) => candidate === eventTarget);
      const metadata = button ? buttonMetadata.get(button) : undefined;
      if (!button || !metadata) {
        return;
      }

      const currentIndex = buttons.indexOf(button);
      switch (event.key) {
        case "ArrowDown":
          event.preventDefault();
          focusMenuItem(menu, currentIndex + 1);
          break;
        case "ArrowUp":
          event.preventDefault();
          focusMenuItem(menu, currentIndex - 1);
          break;
        case "Home":
          event.preventDefault();
          focusMenuItem(menu, 0);
          break;
        case "End":
          event.preventDefault();
          focusMenuItem(menu, buttons.length - 1);
          break;
        case "ArrowRight":
          if (metadata.item.children && metadata.item.children.length > 0) {
            event.preventDefault();
            metadata.openSubmenu(true);
          }
          break;
        case "ArrowLeft": {
          const parentButton = menuParentButtons[menuIndex];
          if (!parentButton) {
            return;
          }
          event.preventDefault();
          closeMenusFromLevel(menuIndex);
          parentButton.focus();
          break;
        }
        case "Enter":
        case " ":
          event.preventDefault();
          if (metadata.item.children && metadata.item.children.length > 0) {
            metadata.openSubmenu(true);
          } else {
            cleanup(metadata.item.id);
          }
          break;
      }
    };

    const onPointerDown = (event: PointerEvent) => {
      if (!canDismissFromPointer || isNodeWithinMenuStack(event.target, menuStack)) {
        return;
      }
      cleanup(null);
    };

    const onContextMenu = (event: MouseEvent) => {
      if (!canDismissFromPointer || isNodeWithinMenuStack(event.target, menuStack)) {
        return;
      }
      event.preventDefault();
      cleanup(null);
    };

    const openMenu = (
      entries: readonly ContextMenuItem<T>[],
      preferredLeft: number,
      preferredTop: number,
      level: number,
      focusFirstItem = false,
      parentButton?: HTMLButtonElement,
    ) => {
      closeMenusFromLevel(level);

      const menu = document.createElement("div");
      menu.className =
        "dropdown-glass fixed z-[10000] min-w-32 max-w-sm overflow-hidden rounded-lg bg-clip-padding text-popover-foreground outline-none";
      menu.style.cssText =
        "position:fixed;z-index:10000;min-width:8rem;max-width:24rem;overflow:hidden;border-radius:var(--radius-lg);background-clip:padding-box;color:var(--popover-foreground);outline:none;pointer-events:auto;";
      menu.style.left = `${preferredLeft}px`;
      menu.style.top = `${preferredTop}px`;
      menu.dataset.level = String(level);
      menu.setAttribute("role", "menu");
      menu.setAttribute("aria-orientation", "vertical");
      menuParentButtons[level] = parentButton ?? null;

      const inner = document.createElement("div");
      inner.className =
        "max-h-[min(24rem,70vh)] min-w-0 max-w-sm overflow-y-auto overflow-x-hidden p-1";
      inner.style.cssText =
        "max-height:min(24rem,70vh);min-width:0;max-width:24rem;overflow-x:hidden;overflow-y:auto;padding:0.25rem;";

      for (const item of entries) {
        if (item.header === true) {
          const header = document.createElement("div");
          header.className = "px-2 py-1.5 font-medium text-muted-foreground text-xs";
          header.textContent = item.label;
          inner.appendChild(header);
          continue;
        }

        const hasChildren = Array.isArray(item.children) && item.children.length > 0;
        const isLeafDestructive =
          !hasChildren && (item.destructive === true || item.id === ("delete" as T));

        const button = document.createElement("button");
        button.type = "button";
        button.tabIndex = -1;
        button.setAttribute("role", "menuitem");
        const isDisabled = item.disabled === true;
        button.disabled = isDisabled;
        const rowBase =
          "flex w-full cursor-default select-none items-center gap-2 rounded-sm px-2 py-1 text-left outline-none transition-colors sm:min-h-7 sm:text-sm min-h-8 text-base";
        button.className = isDisabled
          ? `${rowBase} pointer-events-none cursor-not-allowed text-muted-foreground opacity-64`
          : isLeafDestructive
            ? `${rowBase} text-destructive-foreground hover:bg-destructive/10 hover:text-destructive-foreground`
            : `${rowBase} text-foreground hover:bg-accent hover:text-accent-foreground`;
        button.style.cssText =
          "display:flex;width:100%;min-height:1.75rem;align-items:center;gap:0.5rem;border:0;border-radius:var(--radius-sm);background:transparent;padding:0.25rem 0.5rem;color:var(--foreground);font-family:var(--font-sans,system-ui,sans-serif);font-size:0.875rem;line-height:1.25rem;text-align:left;cursor:default;";
        if (isLeafDestructive) {
          button.style.color = "var(--destructive-foreground)";
        }
        if (isDisabled) {
          button.style.color = "var(--muted-foreground)";
          button.style.opacity = "0.64";
          button.style.pointerEvents = "none";
        }

        if (typeof item.icon === "string") {
          const icon = createIconElement(item.icon, isLeafDestructive ? "destructive" : "neutral");
          if (icon) {
            button.appendChild(icon);
          }
        }

        const label = document.createElement("span");
        label.className = "min-w-0 flex-1 truncate";
        label.textContent = item.label;
        button.appendChild(label);

        if (hasChildren) {
          const chevron = document.createElement("span");
          chevron.className = "ms-auto shrink-0 text-muted-foreground/80 text-sm leading-none";
          chevron.textContent = ">";
          button.appendChild(chevron);
          button.setAttribute("aria-haspopup", "menu");
          button.setAttribute("aria-expanded", "false");
        }

        if (!isDisabled) {
          let isHovered = false;
          let isFocused = false;
          const applyInteractionStyles = () => {
            const isActive = isHovered || isFocused;
            button.style.background = isActive
              ? isLeafDestructive
                ? "color-mix(in srgb, var(--destructive) 10%, transparent)"
                : "var(--accent)"
              : "transparent";
            button.style.color = isActive
              ? isLeafDestructive
                ? "var(--destructive-foreground)"
                : "var(--accent-foreground)"
              : isLeafDestructive
                ? "var(--destructive-foreground)"
                : "var(--foreground)";
          };
          button.addEventListener("focus", () => {
            isFocused = true;
            applyInteractionStyles();
          });
          button.addEventListener("blur", () => {
            isFocused = false;
            applyInteractionStyles();
          });
          button.addEventListener("mouseenter", () => {
            isHovered = true;
            applyInteractionStyles();
          });
          button.addEventListener("mouseleave", () => {
            isHovered = false;
            applyInteractionStyles();
          });

          const openSubmenu = (shouldFocusFirst: boolean) => {
            const rect = button.getBoundingClientRect();
            button.setAttribute("aria-expanded", "true");
            openMenu(item.children!, rect.right + 4, rect.top, level + 1, shouldFocusFirst, button);

            const childMenu = menuStack[level + 1];
            if (!childMenu) {
              return;
            }
            const childRect = childMenu.getBoundingClientRect();
            if (childRect.right > window.innerWidth) {
              clampMenuPosition(childMenu, rect.left - childRect.width - 4, rect.top);
            }
          };
          buttonMetadata.set(button, { item, openSubmenu });

          if (hasChildren) {
            button.addEventListener("mouseenter", () => {
              openSubmenu(false);
            });
            button.addEventListener("click", (event) => {
              event.preventDefault();
              openSubmenu(true);
            });
          } else {
            button.addEventListener("mouseenter", () => {
              closeMenusFromLevel(level + 1);
            });
            button.addEventListener("click", () => {
              if (canDismissFromPointer) cleanup(item.id);
            });
          }
        }

        inner.appendChild(button);
      }

      menu.appendChild(inner);

      menu.addEventListener("mouseenter", () => {
        closeMenusFromLevel(level + 1);
      });

      document.body.appendChild(menu);
      menuStack[level] = menu;

      requestAnimationFrame(() => {
        clampMenuPosition(menu, preferredLeft, preferredTop);
        if (focusFirstItem) {
          focusMenuItem(menu, 0);
        }
      });
    };

    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("contextmenu", onContextMenu, true);
    openMenu(items, position?.x ?? 0, position?.y ?? 0, 0, true);

    requestAnimationFrame(() => {
      canDismissFromPointer = true;
    });
  });
}
