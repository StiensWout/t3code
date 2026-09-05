import { useEffect, useRef, useState, type ReactNode } from "react";
import { LRUCache } from "../lib/lruCache";
import {
  markdownHighlighting,
  type MarkdownHighlightInput,
  type MarkdownHighlightResult,
} from "../lib/markdownHighlighting";

const completedHighlights = new LRUCache<string>(500, 50 * 1024 * 1024);

/** Keep append-only streaming results visible while the worker catches up. */
export function MarkdownCodeHighlight({
  code,
  language,
  themeName,
  isStreaming,
  fallback,
}: MarkdownHighlightInput & { isStreaming: boolean; fallback: ReactNode }) {
  const [result, setResult] = useState<MarkdownHighlightResult | null>(null);
  const subscription = useRef<ReturnType<typeof markdownHighlighting.subscribe> | null>(null);
  // Full source keys avoid hash collisions; the cache budget includes their storage.
  const cacheKey = isStreaming ? null : `${themeName}:${language.length}:${language}:${code}`;
  const cached = cacheKey === null ? null : completedHighlights.get(cacheKey);

  useEffect(() => {
    const block = markdownHighlighting.subscribe(setResult);
    subscription.current = block;
    return () => {
      block.dispose();
      subscription.current = null;
    };
  }, []);

  const compatible =
    result !== null &&
    result.language === language &&
    result.themeName === themeName &&
    code.startsWith(result.code);
  const complete = compatible && result.code === code && result.html !== null;

  useEffect(() => {
    if ((isStreaming || cached === null) && !complete) {
      subscription.current?.highlight({ code, language, themeName });
    }
  }, [code, language, themeName, cached, isStreaming, complete]);

  const html = cached ?? (compatible ? result.html : null);

  useEffect(() => {
    if (cacheKey !== null && compatible && result.code === code && result.html !== null) {
      completedHighlights.set(cacheKey, result.html, (cacheKey.length + result.html.length) * 2);
    }
  }, [cacheKey, code, compatible, result]);

  return html === null ? (
    fallback
  ) : (
    <div className="chat-markdown-shiki" dangerouslySetInnerHTML={{ __html: html }} />
  );
}
