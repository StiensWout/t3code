import { resolveLanguages, resolveThemes, type SupportedLanguages } from "@pierre/diffs";
import MarkdownHighlightWorker from "./markdownHighlighting.worker?worker";
import type { DiffThemeName } from "./diffRendering";

export interface MarkdownHighlightInput {
  code: string;
  language: string;
  themeName: DiffThemeName;
}

export interface MarkdownHighlightRequest extends MarkdownHighlightInput {
  id: number;
  resolvedLanguages?: Awaited<ReturnType<typeof resolveLanguages>>;
  resolvedThemes?: Awaited<ReturnType<typeof resolveThemes>>;
}

export interface MarkdownHighlightResponse {
  id: number;
  html: string | null;
}

export interface MarkdownHighlightResult extends MarkdownHighlightInput {
  html: string | null;
}

type Block = { receive: (result: MarkdownHighlightResult) => void };
type Job = { block: Block; request: MarkdownHighlightRequest };

/** One shared worker, with at most one queued update per mounted code block. */
export class MarkdownHighlighting {
  private worker: Worker | undefined;
  private active: Job | undefined;
  private pending = new Map<Block, MarkdownHighlightRequest>();
  private blocks = new Set<Block>();
  private nextId = 0;
  private sentLanguages = new Set<string>();
  private sentThemes = new Set<string>();

  constructor(private readonly createWorker = () => new MarkdownHighlightWorker()) {}

  subscribe(receive: Block["receive"]) {
    const block = { receive };
    this.blocks.add(block);
    return {
      highlight: (input: MarkdownHighlightInput) => {
        if (!this.blocks.has(block)) return;
        this.pending.set(block, { ...input, id: ++this.nextId });
        this.pump();
      },
      dispose: () => {
        this.blocks.delete(block);
        this.pending.delete(block);
        if (this.blocks.size === 0) {
          this.worker?.terminate();
          this.worker = undefined;
          this.active = undefined;
        }
      },
    };
  }

  private fail() {
    const jobs = [...this.pending].map(([block, request]) => ({ block, request }));
    if (this.active) jobs.unshift(this.active);
    this.worker?.terminate();
    this.worker = undefined;
    this.active = undefined;
    this.pending.clear();
    for (const { block, request } of jobs) {
      if (this.blocks.has(block)) block.receive({ ...request, html: null });
    }
  }

  private async send(worker: Worker, request: MarkdownHighlightRequest) {
    try {
      // Pierre resolves grammar/theme modules on the renderer; tokenization and
      // HTML generation run in the worker. Send each definition once per worker.
      const [resolvedLanguages, resolvedThemes] = await Promise.all([
        this.sentLanguages.has(request.language)
          ? undefined
          : resolveLanguages([request.language as SupportedLanguages]).catch(() => []),
        this.sentThemes.has(request.themeName) ? undefined : resolveThemes([request.themeName]),
      ]);
      if (this.worker !== worker || this.active?.request !== request) return;
      worker.postMessage({ ...request, resolvedLanguages, resolvedThemes }, []);
      if (resolvedLanguages === undefined || resolvedLanguages.length > 0) {
        this.sentLanguages.add(request.language);
      }
      this.sentThemes.add(request.themeName);
    } catch {
      if (this.worker === worker) this.fail();
    }
  }

  private pump() {
    if (this.active) return;
    const next = this.pending.entries().next().value;
    if (!next) return;
    const [block, request] = next;
    this.pending.delete(block);
    this.active = { block, request };
    try {
      if (!this.worker) {
        const worker = this.createWorker();
        this.worker = worker;
        this.sentLanguages.clear();
        this.sentThemes.clear();
        worker.addEventListener("message", (event: MessageEvent<MarkdownHighlightResponse>) => {
          if (this.worker !== worker || this.active?.request.id !== event.data.id) return;
          const job = this.active;
          this.active = undefined;
          if (event.data.html === null) {
            worker.terminate();
            this.worker = undefined;
          }
          if (this.blocks.has(job.block)) {
            job.block.receive({ ...job.request, html: event.data.html });
          }
          this.pump();
        });
        const fail = () => {
          if (this.worker === worker) this.fail();
        };
        worker.addEventListener("error", fail);
        worker.addEventListener("messageerror", fail);
      }
      void this.send(this.worker, request);
    } catch {
      this.fail();
    }
  }
}

export const markdownHighlighting = new MarkdownHighlighting();
