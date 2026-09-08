import { lazy, memo, Suspense, useState } from "react";
import { markdownMath } from "@t3tools/client-runtime/markdown-math";
import { RenderErrorBoundary } from "./RenderErrorBoundary";
import { toastManager } from "./ui/toast";

// The renderer and its fonts are loaded only when a message contains math.
const MathTypeset = lazy(() => import("./MathTypeset"));

export const MarkdownMath = memo(function MarkdownMath({ source }: { source: string }) {
  const math = markdownMath(source);
  const [showSource, setShowSource] = useState(false);
  if (!math) return <>{source}</>;
  const fallback = <span className="whitespace-pre-wrap font-mono text-xs">{source}</span>;
  return (
    <span
      className={math.display ? "markdown-math markdown-math-display" : "markdown-math"}
      data-markdown-math=""
      data-markdown-copy={source}
    >
      {math.display ? (
        <span className="markdown-math-actions select-none">
          <button
            type="button"
            onClick={() => {
              if (!navigator.clipboard) {
                toastManager.add({ type: "error", title: "Could not copy TeX" });
                return;
              }
              void navigator.clipboard.writeText(source).then(
                () => toastManager.add({ type: "success", title: "TeX copied" }),
                () => toastManager.add({ type: "error", title: "Could not copy TeX" }),
              );
            }}
          >
            Copy TeX
          </button>
          <button
            type="button"
            aria-expanded={showSource}
            onClick={() => setShowSource(!showSource)}
          >
            {showSource ? "Hide source" : "TeX source"}
          </button>
        </span>
      ) : null}
      <span
        className="markdown-math-viewport"
        tabIndex={math.display ? 0 : undefined}
        role={math.display ? "region" : undefined}
        aria-label={math.display ? "Equation" : undefined}
      >
        <RenderErrorBoundary fallback={fallback} resetKeys={[source]}>
          <Suspense fallback={fallback}>
            <MathTypeset source={source} />
          </Suspense>
        </RenderErrorBoundary>
      </span>
      {showSource && math.display ? <span className="markdown-math-source">{source}</span> : null}
    </span>
  );
});
