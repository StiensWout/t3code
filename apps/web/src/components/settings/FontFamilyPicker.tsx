import { LegendList } from "@legendapp/list/react";
import { CheckIcon, ChevronDownIcon, SearchIcon } from "lucide-react";
import { useMemo, useState } from "react";
import {
  type InstalledFontFamiliesResult,
  isMonospaceFamily,
  queryInstalledFontFamilies,
} from "../../appearanceFonts";
import {
  Combobox,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxListVirtualized,
  ComboboxPopup,
  ComboboxTrigger,
} from "../ui/combobox";

const DEFAULT_FONT_VALUE = "__default__";

/**
 * Whether the engine can enumerate installed fonts (Local Font Access API -
 * Chromium and Electron). Rows fall back to a plain family-name input
 * elsewhere.
 */
export function supportsFontEnumeration(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof (window as { queryLocalFonts?: unknown }).queryLocalFonts === "function"
  );
}

/**
 * A searchable picker over every installed family, the way native editors
 * list system fonts. Enumeration happens on open - that click is the user
 * gesture the local-fonts permission prompt requires.
 */
export function FontFamilyPicker({
  ariaLabel,
  defaultLabel = "Default",
  selectedFamily,
  requireMonospace = false,
  onSelect,
}: {
  ariaLabel: string;
  /** What the Default choice reads as, e.g. "Default (SF Mono)". */
  defaultLabel?: string;
  /** Committed family name; empty string means the built-in default. */
  selectedFamily: string;
  requireMonospace?: boolean;
  onSelect: (family: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [installed, setInstalled] = useState<InstalledFontFamiliesResult | null>(null);

  const handleOpenChange = (nextOpen: boolean) => {
    setOpen(nextOpen);
    if (!nextOpen) return;
    setQuery("");
    if (installed?.status !== "granted") {
      void queryInstalledFontFamilies().then(setInstalled);
    }
  };

  const families = useMemo(() => {
    if (installed?.status !== "granted") return [];
    return requireMonospace ? installed.families.filter(isMonospaceFamily) : installed.families;
  }, [installed, requireMonospace]);

  const items = useMemo(() => {
    const trimmedQuery = query.trim().toLowerCase();
    const result: string[] = [];
    if (trimmedQuery.length === 0) result.push(DEFAULT_FONT_VALUE);
    result.push(
      ...families.filter(
        (family) => trimmedQuery.length === 0 || family.toLowerCase().includes(trimmedQuery),
      ),
    );
    return result;
  }, [query, families]);

  const selectedValue = selectedFamily.length === 0 ? DEFAULT_FONT_VALUE : selectedFamily;

  const handlePick = (value: string) => {
    setOpen(false);
    onSelect(value === DEFAULT_FONT_VALUE ? "" : value);
  };

  const renderItem = (item: string, index: number) => (
    <ComboboxItem
      hideIndicator
      index={index}
      key={item}
      value={item}
      onClick={() => handlePick(item)}
    >
      <div className="flex w-full min-w-0 items-center justify-between gap-2">
        <span
          className="min-w-0 truncate"
          style={item === DEFAULT_FONT_VALUE ? undefined : { fontFamily: item }}
        >
          {item === DEFAULT_FONT_VALUE ? defaultLabel : item}
        </span>
        {item === selectedValue ? (
          <CheckIcon className="size-3.5 shrink-0 text-muted-foreground" />
        ) : null}
      </div>
    </ComboboxItem>
  );

  const statusNotice =
    installed?.status === "denied"
      ? "Font access was declined in the browser."
      : open && installed === null
        ? "Reading installed fonts…"
        : null;

  return (
    <Combobox
      items={items}
      filteredItems={items}
      autoHighlight
      virtualized
      open={open}
      onOpenChange={handleOpenChange}
      value={selectedValue}
    >
      <ComboboxTrigger
        aria-label={ariaLabel}
        className="relative inline-flex min-h-9 w-full min-w-36 cursor-pointer select-none items-center justify-between gap-2 rounded-lg border border-input bg-background px-[calc(--spacing(3)-1px)] text-left text-base text-foreground shadow-xs/5 outline-none transition-[color,box-shadow] focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/24 sm:min-h-8 sm:text-sm dark:bg-input/32"
      >
        <span className="min-w-0 truncate">
          {selectedFamily.length === 0 ? defaultLabel : selectedFamily}
        </span>
        <ChevronDownIcon className="-me-1 size-3 shrink-0 text-muted-foreground opacity-50" />
      </ComboboxTrigger>
      <ComboboxPopup align="end" className="flex w-72 flex-col">
        <div className="shrink-0 px-3 pt-2.5">
          <div className="relative -translate-y-px border-b border-border/70 pb-1.5 transition-colors focus-within:border-ring">
            <SearchIcon
              aria-hidden="true"
              className="pointer-events-none absolute top-1.5 left-0 size-4 shrink-0 text-muted-foreground/55"
            />
            <ComboboxInput
              className="[&_input]:h-6.5 [&_input]:ps-5 [&_input]:font-sans [&_input]:leading-6.5"
              inputClassName="rounded-none bg-transparent text-sm"
              placeholder="Search fonts…"
              showTrigger={false}
              size="sm"
              unstyled
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
        </div>
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          <ComboboxEmpty>No fonts found.</ComboboxEmpty>
          <div className="relative min-h-0 max-h-72 w-full flex-1 overflow-hidden">
            <ComboboxListVirtualized className="size-full min-w-0 p-0">
              <LegendList<string>
                data={items}
                keyExtractor={(item) => item}
                renderItem={({ item, index }) => renderItem(item, index)}
                estimatedItemSize={30}
                drawDistance={360}
                style={{ height: Math.min(items.length * 30, 288) }}
              />
            </ComboboxListVirtualized>
          </div>
          {statusNotice ? (
            <div className="shrink-0 border-t border-border/60 px-3 py-1.5 text-[11px] text-muted-foreground/70">
              {statusNotice}
            </div>
          ) : null}
        </div>
      </ComboboxPopup>
    </Combobox>
  );
}
