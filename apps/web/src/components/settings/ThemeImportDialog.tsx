import { PlusIcon, UploadIcon } from "lucide-react";
import type { ChangeEvent, UIEvent } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { installCustomTheme, parseThemeFile, type ThemeDefinition } from "../../themePalette";
import { Alert } from "../ui/alert";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";

function escapeJsonHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[character] ?? character,
  );
}

function highlightJson(value: string): string {
  const tokenPattern =
    /"(?:\\.|[^"\\])*"|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null/g;
  let highlighted = "";
  let cursor = 0;

  for (const match of value.matchAll(tokenPattern)) {
    const token = match[0];
    const index = match.index ?? 0;
    highlighted += escapeJsonHtml(value.slice(cursor, index));

    let tokenClass = "theme-json-number";
    if (token.startsWith('"')) {
      tokenClass = /^\s*:/.test(value.slice(index + token.length))
        ? "theme-json-key"
        : "theme-json-string";
    } else if (token === "true" || token === "false" || token === "null") {
      tokenClass = "theme-json-constant";
    }
    highlighted += `<span class="${tokenClass}">${escapeJsonHtml(token)}</span>`;
    cursor = index + token.length;
  }

  return highlighted + escapeJsonHtml(value.slice(cursor));
}

function ThemeJsonEditor({
  id,
  value,
  onChange,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
}) {
  const highlightRef = useRef<HTMLPreElement>(null);
  const highlightedJson = useMemo(() => highlightJson(value), [value]);

  const syncScroll = useCallback((event: UIEvent<HTMLTextAreaElement>) => {
    const highlightElement = highlightRef.current;
    if (!highlightElement) return;
    highlightElement.scrollTop = event.currentTarget.scrollTop;
    highlightElement.scrollLeft = event.currentTarget.scrollLeft;
  }, []);

  return (
    <div className="relative overflow-hidden rounded-xl border border-input bg-background shadow-xs/5 focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/24">
      <pre
        ref={highlightRef}
        aria-hidden
        className="pointer-events-none absolute inset-0 m-0 overflow-hidden whitespace-pre-wrap break-words p-3 font-mono text-[12px] leading-5 text-foreground"
      >
        <code dangerouslySetInnerHTML={{ __html: highlightedJson }} />
      </pre>
      <textarea
        aria-label="Theme JSON"
        className="relative z-10 block min-h-72 w-full resize-y overflow-auto bg-transparent p-3 font-mono text-[12px] leading-5 text-transparent caret-foreground outline-none placeholder:text-muted-foreground selection:bg-accent/30 selection:text-transparent"
        id={id}
        onChange={(event) => onChange(event.currentTarget.value)}
        onScroll={syncScroll}
        placeholder={
          '{\n  "version": 1,\n  "name": "Aurora",\n  "appearance": "light",\n  "colors": { ... }\n}'
        }
        spellCheck={false}
        value={value}
      />
    </div>
  );
}

export function ThemeImportDialog({
  open,
  onOpenChange,
  onImported,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onImported: (theme: ThemeDefinition) => boolean;
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [json, setJson] = useState("");
  const [fileName, setFileName] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isReading, setIsReading] = useState(false);
  const importRequestRef = useRef(0);

  useEffect(() => {
    importRequestRef.current += 1;
    if (!open) return;
    setJson("");
    setFileName(null);
    setError(null);
    setIsReading(false);
  }, [open]);

  const handleFileChange = useCallback(async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (!file) return;

    const requestId = ++importRequestRef.current;
    setIsReading(true);
    try {
      const fileText = await file.text();
      if (requestId !== importRequestRef.current) return;
      setJson(fileText);
      setFileName(file.name);
      setError(null);
    } catch {
      if (requestId !== importRequestRef.current) return;
      setError("Could not read that file. Paste the JSON below instead.");
    } finally {
      if (requestId === importRequestRef.current) setIsReading(false);
    }
  }, []);

  const handleSubmit = useCallback(() => {
    try {
      const installedTheme = installCustomTheme(parseThemeFile(JSON.parse(json)));
      if (!onImported(installedTheme)) {
        setError("Theme added, but it could not be selected. Try again.");
        return;
      }
      onOpenChange(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "That theme file is invalid.");
    }
  }, [json, onImported, onOpenChange]);

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) setError(null);
        onOpenChange(nextOpen);
      }}
    >
      <DialogPopup className="max-w-3xl overflow-hidden">
        <DialogHeader>
          <DialogTitle>Add a theme</DialogTitle>
          <DialogDescription>
            Choose a JSON file or paste one below. Both options use the same theme format.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-dashed border-border/80 bg-muted/20 px-3 py-3">
            <div className="min-w-0">
              <p className="text-sm font-medium">Theme file</p>
              <p className="truncate text-xs text-muted-foreground">
                {fileName ?? "Upload a .json file, or paste the contents below."}
              </p>
            </div>
            <Button
              disabled={isReading}
              size="sm"
              variant="outline"
              onClick={() => fileInputRef.current?.click()}
            >
              <UploadIcon />
              {isReading ? "Reading…" : "Choose JSON file"}
            </Button>
            <input
              ref={fileInputRef}
              accept=".json,application/json"
              className="sr-only"
              onChange={handleFileChange}
              type="file"
            />
          </div>

          <div className="space-y-2">
            <div className="flex items-baseline justify-between gap-3">
              <label className="text-sm font-medium" htmlFor="theme-json-editor">
                Paste theme JSON
              </label>
              <span className="text-xs text-muted-foreground">JSON</span>
            </div>
            <ThemeJsonEditor id="theme-json-editor" onChange={setJson} value={json} />
            <p className="text-xs leading-relaxed text-muted-foreground">
              Export a theme from T3 Code to get a complete file, then edit the colors you want.
            </p>
          </div>

          {error ? (
            <Alert aria-live="polite" variant="error">
              {error}
            </Alert>
          ) : null}
        </DialogPanel>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={!json.trim() || isReading} onClick={handleSubmit}>
            <PlusIcon />
            Add theme
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
