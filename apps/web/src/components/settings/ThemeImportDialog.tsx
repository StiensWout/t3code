import { PlusIcon, UploadIcon } from "lucide-react";
import type { ChangeEvent, DragEvent, UIEvent } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { cn } from "../../lib/utils";
import {
  installCustomTheme,
  parseThemeFile,
  removeCustomTheme,
  type ThemeDefinition,
} from "../../themePalette";
import { isVsCodeThemeFile, parseVsCodeThemeFile } from "../../vscodeThemeImport";
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

/**
 * A full theme export is a few KB, so anything past this is not a theme file.
 * The guard runs on the size before the bytes are ever read: a large file
 * would otherwise be pulled into memory, highlighted, and rendered, which
 * locks the UI for as long as that takes.
 */
export const MAX_THEME_FILE_BYTES = 256 * 1024;

/** Highlighting rebuilds the whole markup on every keystroke, so oversized
 *  pastes fall back to plain text instead of freezing the editor. */
const MAX_HIGHLIGHTED_JSON_LENGTH = 20_000;

function formatByteSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} bytes`;
}

/** Returns the error to show for a file too large to be a theme, else null. */
export function describeOversizedThemeFile(bytes: number): string | null {
  if (bytes <= MAX_THEME_FILE_BYTES) return null;
  return `That file is ${formatByteSize(bytes)}. Theme files are only a few KB, so this one was not read (limit ${formatByteSize(MAX_THEME_FILE_BYTES)}).`;
}

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
  const isPlainText = value.length > MAX_HIGHLIGHTED_JSON_LENGTH;
  const highlightedJson = useMemo(
    () => (value.length > MAX_HIGHLIGHTED_JSON_LENGTH ? "" : highlightJson(value)),
    [value],
  );

  const syncScroll = useCallback((event: UIEvent<HTMLTextAreaElement>) => {
    const highlightElement = highlightRef.current;
    if (!highlightElement) return;
    highlightElement.scrollTop = event.currentTarget.scrollTop;
    highlightElement.scrollLeft = event.currentTarget.scrollLeft;
  }, []);

  return (
    <div className="relative overflow-hidden rounded-xl border border-input bg-background shadow-xs/5 focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/24">
      {isPlainText ? null : (
        <pre
          ref={highlightRef}
          aria-hidden
          className="pointer-events-none absolute inset-0 m-0 overflow-hidden whitespace-pre-wrap break-words p-3 font-mono text-[12px] leading-5 text-foreground"
        >
          <code dangerouslySetInnerHTML={{ __html: highlightedJson }} />
        </pre>
      )}
      <textarea
        aria-label="Theme JSON"
        className={cn(
          "relative z-10 block min-h-72 w-full resize-y overflow-auto bg-transparent p-3 font-mono text-[12px] leading-5 caret-foreground outline-none placeholder:text-muted-foreground selection:bg-accent/30",
          isPlainText ? "text-foreground" : "text-transparent selection:text-transparent",
        )}
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
  const [isDropTarget, setIsDropTarget] = useState(false);
  const importRequestRef = useRef(0);

  useEffect(() => {
    importRequestRef.current += 1;
    if (!open) return;
    setJson("");
    setFileName(null);
    setError(null);
    setIsReading(false);
  }, [open]);

  const readThemeFile = useCallback(async (file: File) => {
    // Check the size first: reading a large file is what locks the UI, so it
    // never gets read at all.
    const oversized = describeOversizedThemeFile(file.size);
    if (oversized) {
      setError(oversized);
      return;
    }

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

  const handleFileChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const file = event.currentTarget.files?.[0];
      event.currentTarget.value = "";
      if (file) void readThemeFile(file);
    },
    [readThemeFile],
  );

  const handleDrop = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      setIsDropTarget(false);
      const file = event.dataTransfer.files[0];
      if (file) void readThemeFile(file);
    },
    [readThemeFile],
  );

  const handleSubmit = useCallback(() => {
    // Pasted text bypasses the file guard, so the same limit applies here.
    const oversized = describeOversizedThemeFile(json.length);
    if (oversized) {
      setError(oversized);
      return;
    }
    try {
      const parsed: unknown = JSON.parse(json);
      // VS Code themes are converted on the way in; anything else has to be
      // one of our own files.
      const installedTheme = installCustomTheme(
        isVsCodeThemeFile(parsed) ? parseVsCodeThemeFile(parsed) : parseThemeFile(parsed),
      );
      if (!onImported(installedTheme)) {
        // Roll the install back so a retry can run it again instead of
        // failing on the already-taken theme id.
        try {
          removeCustomTheme(installedTheme.id);
        } catch {
          // Storage is failing wholesale; the error below covers it.
        }
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
            Drop in a theme JSON file or paste one below. VS Code color themes are converted
            automatically.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-4">
          <div
            className={cn(
              "flex flex-wrap items-center justify-between gap-3 rounded-xl border border-dashed px-3 py-3 transition-colors",
              isDropTarget ? "border-ring bg-accent/20" : "border-border/80 bg-muted/20",
            )}
            onDragEnter={(event) => {
              event.preventDefault();
              setIsDropTarget(true);
            }}
            onDragOver={(event) => {
              event.preventDefault();
              setIsDropTarget(true);
            }}
            onDragLeave={(event) => {
              // Ignore moves between children of the drop zone.
              if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
              setIsDropTarget(false);
            }}
            onDrop={handleDrop}
          >
            <div className="min-w-0">
              <p className="text-sm font-medium">Theme file</p>
              <p className="truncate text-xs text-muted-foreground">
                {fileName ?? "Drop a T3 Code or VS Code theme .json here, or paste it below."}
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
              Export an existing theme to get a full file you can tweak.
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
