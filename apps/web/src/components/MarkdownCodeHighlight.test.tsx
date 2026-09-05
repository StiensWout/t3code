import { act, StrictMode, type ComponentProps } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, expect, it, vi } from "vite-plus/test";
import type { MarkdownHighlightRequest } from "../lib/markdownHighlighting";

const transport = vi.hoisted(() => ({
  workers: [] as Array<{
    requests: MarkdownHighlightRequest[];
    reply: (html: string | null) => void;
    fail: () => void;
    terminated: boolean;
  }>,
  failConstruction: false,
}));

vi.mock("@pierre/diffs", () => ({
  resolveLanguages: async () => [],
  resolveThemes: async () => [],
}));

vi.mock("../lib/markdownHighlighting.worker?worker", () => ({
  default: class extends EventTarget {
    requests: MarkdownHighlightRequest[] = [];
    terminated = false;
    constructor() {
      super();
      if (transport.failConstruction) throw new Error("Worker unavailable");
      transport.workers.push(this);
    }
    postMessage(request: MarkdownHighlightRequest) {
      this.requests.push(request);
    }
    reply(html: string | null) {
      const request = this.requests.shift();
      if (!request) throw new Error("No outstanding highlight");
      this.dispatchEvent(new MessageEvent("message", { data: { id: request.id, html } }));
    }
    fail() {
      this.dispatchEvent(new Event("error"));
    }
    terminate() {
      this.terminated = true;
    }
  },
}));

import { MarkdownCodeHighlight } from "./MarkdownCodeHighlight";

let renderer: ReactTestRenderer | undefined;
vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  transport.workers.length = 0;
  transport.failConstruction = false;
});

const props: Omit<ComponentProps<typeof MarkdownCodeHighlight>, "fallback"> = {
  code: "a",
  language: "typescript",
  themeName: "pierre-dark",
  isStreaming: true,
};

async function render(overrides: Partial<typeof props> = {}) {
  const current = { ...props, ...overrides };
  const element = <MarkdownCodeHighlight {...current} fallback={<pre>{current.code}</pre>} />;
  await act(async () => {
    if (renderer) renderer.update(element);
    else renderer = create(element);
  });
}
function html() {
  return renderer!.root.findAllByProps({ className: "chat-markdown-shiki" })[0]?.props
    .dangerouslySetInnerHTML.__html;
}

it("coalesces a growing fence while keeping live results and caching only completion", async () => {
  await render();
  const worker = transport.workers[0]!;
  await render({ code: "ab" });
  await render({ code: "abc" });
  await act(async () => worker.reply("<pre>a</pre>"));
  expect(html()).toBe("<pre>a</pre>");
  expect(worker.requests.map((request) => request.code)).toEqual(["abc"]);
  await act(async () => worker.reply("<pre>abc</pre>"));
  expect(html()).toBe("<pre>abc</pre>");
  await render({ code: "abc", isStreaming: false });
  expect(worker.requests).toHaveLength(0);
  await act(async () => renderer?.unmount());
  renderer = undefined;
  await render({ code: "abc", isStreaming: false });
  expect(html()).toBe("<pre>abc</pre>");
  expect(transport.workers).toHaveLength(1);
});

it("rejects results from replaced source, language, and theme", async () => {
  await render();
  const worker = transport.workers[0]!;
  await render({ code: "replacement", language: "python", themeName: "pierre-light" });
  await act(async () => worker.reply("<pre>stale dark TypeScript</pre>"));
  expect(html()).toBeUndefined();
  await act(async () => worker.reply("<pre>replacement</pre>"));
  expect(html()).toBe("<pre>replacement</pre>");
  await render({ code: "replacement", language: "text", themeName: "pierre-light" });
  expect(html()).toBeUndefined();
  await act(async () => worker.reply("<pre>text</pre>"));
  await render({ code: "replacement", language: "text", themeName: "pierre-dark" });
  expect(html()).toBeUndefined();
  await act(async () => worker.reply("<pre>dark</pre>"));
  expect(html()).toBe("<pre>dark</pre>");
});

it("shows source on failure and retries on a later update", async () => {
  transport.failConstruction = true;
  await render({ code: "failed construction" });
  expect(renderer!.root.findByType("pre").children).toEqual(["failed construction"]);
  transport.failConstruction = false;
  await render({ code: "retry" });
  const worker = transport.workers[0]!;
  await act(async () => worker.reply(null));
  expect(renderer!.root.findByType("pre").children).toEqual(["retry"]);
  await render({ code: "retry again" });
  await act(async () => transport.workers[1]!.fail());
  expect(worker.terminated).toBe(true);
  await render({ code: "recovered" });
  await act(async () => transport.workers[2]!.reply("<pre>recovered</pre>"));
  expect(html()).toBe("<pre>recovered</pre>");
});

it("shares work fairly across blocks and cancels removed blocks", async () => {
  const block = (key: string, code: string) => (
    <MarkdownCodeHighlight key={key} {...props} code={code} fallback={<pre>{code}</pre>} />
  );
  await act(async () => {
    renderer = create(<StrictMode>{[block("one", "first"), block("two", "second")]}</StrictMode>);
  });
  const worker = transport.workers.at(-1)!;
  await act(async () => {
    renderer!.update(<StrictMode>{[block("two", "second latest")]}</StrictMode>);
  });
  await act(async () => worker.reply("<pre>removed</pre>"));
  expect(html()).toBeUndefined();
  expect(worker.requests.map((request) => request.code)).toEqual(["second latest"]);
  await act(async () => worker.reply("<pre>second latest</pre>"));
  expect(html()).toBe("<pre>second latest</pre>");
  await act(async () => renderer!.unmount());
  renderer = undefined;
  expect(transport.workers.every((worker) => worker.terminated)).toBe(true);
});

it("retries a failed final chunk when streaming completes without re-highlighting success", async () => {
  await render({ code: "final chunk" });
  await act(async () => transport.workers[0]!.reply(null));
  expect(html()).toBeUndefined();
  await render({ code: "final chunk", isStreaming: false });
  await act(async () => transport.workers[1]!.reply("<pre>final chunk</pre>"));
  expect(html()).toBe("<pre>final chunk</pre>");
  expect(transport.workers[1]!.requests).toHaveLength(0);
});
