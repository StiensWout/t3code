import { EnvironmentId, ThreadId, type ScopedThreadRef } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { Root, RootContent } from "mdast";
import remarkParse from "remark-parse";
import { unified } from "unified";

import { DEFAULT_HOSTED_APP_URL } from "./connectAuth.ts";

export const THREAD_LINK_PROTOCOL = "t3-thread";
const V1_PREFIX = `${THREAD_LINK_PROTOCOL}://v1/`;
const V2_PREFIX = `${THREAD_LINK_PROTOCOL}://v2/`;
const HOSTED_PREFIX = `${DEFAULT_HOSTED_APP_URL}/threads/`;
const HOSTED_SEGMENT = "[A-Za-z0-9_%-]+";
const HOSTED_LINK = `${HOSTED_PREFIX.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}${HOSTED_SEGMENT}/${HOSTED_SEGMENT}`;
const THREAD_HREF = String.raw`t3-thread:\/\/v[12]\/`;
// A label stops at any bracket, so a run of unclosed brackets is scanned once, not once per bracket.
const LABEL = String.raw`[^[\]\n]*`;
const LIST_MARKER = String.raw`(?:[-*+]|\d{1,9}[.)])`;
const LIST_MARKERS = String.raw`(?:${LIST_MARKER}[ \t]+)*`;
const POSSIBLE_LIST = new RegExp(String.raw`^[\uFEFF \t>]*${LIST_MARKER}(?:[ \t]|$)`, "m");
const FENCE = /`{3,}|~{3,}/;
const markdownParser = unified().use(remarkParse);
// CommonMark fences start on their own line (optional blockquotes, indentation, or list markers)
// and close on a line with at least as many of the same marker; backtick info strings hold no `.
// Quote markers are compared from the first `>`, so lines may indent them differently.
// Space after the markers is matched only after a `>`: two adjacent `[ \t]*` backtrack quadratically.
const AFTER_QUOTE = String.raw`(?:(?<=>)[ \t]*)?`;
const fencedCode = (char: "`" | "~", name: string) => {
  const bq = `${name}Bq`;
  const info = char === "`" ? "[^`\\r\\n]*" : "[^\\r\\n]*";
  const closer = String.raw`[ \t]*\k<${bq}>${AFTER_QUOTE}\k<${name}>${char}*(?!${char})[ \t]*\r?$`;
  return String.raw`^[ \t]*${LIST_MARKERS}(?<${bq}>(?:>(?:[ \t]*>)*)?)(?:(?<=>)[ \t]*${LIST_MARKERS})?(?<${name}>${char}{3,}(?!${char}))${info}(?=\r?$)(?:\r?\n(?!${closer})[ \t]*\k<${bq}>[^\r\n]*)*(?:\r?\n${closer})?`;
};
// A code span may wrap lines but ends where its paragraph does: a blank line, heading, list item, or fence.
const SPAN_LINE_BREAK = String.raw`\n(?![ \t>]*(?:\r?$|#{1,6}(?:[ \t]|\r?$)|(?:[-*+]|\d{1,9}[.)])[ \t]|\`{3,}[^\`\r\n]*\r?$|~{3,}))`;
// Earlier alternatives claim text so later ones cannot match inside it: an escaped character opens
// nothing, code is literal, and a link to anywhere else keeps a thread URL in its label or href.
const THREAD_LINK_OUTSIDE_CODE = new RegExp(
  [
    String.raw`\\[!-/:-@[-\`{-~]`,
    fencedCode("`", "bt"),
    fencedCode("~", "tl"),
    String.raw`(?<span>(?<!\`)(?<spanTicks>\`+)(?!\`)(?:[^\n]|${SPAN_LINE_BREAK})*?(?<!\`)\k<spanTicks>(?!\`))`,
    // A labeled link's destination may be angle-bracketed, as CommonMark allows: [label](<href>).
    String.raw`\[(?<label>${LABEL})\]\((?:<(?<angleHref>${THREAD_HREF}[^\s<>]+|${HOSTED_LINK})>|(?<href>${THREAD_HREF}[^\s>)]+|${HOSTED_LINK}))\)`,
    String.raw`\[${LABEL}\]\((?:<[^<>\n]*>|[^\s()]*(?:\([^\s()]*\)[^\s()]*)*)(?:[ \t]+(?:"[^"\n]*"|'[^'\n]*'))?\)`,
    String.raw`<(?<autolink>${THREAD_HREF}[^\s<>]+|${HOSTED_LINK})>`,
    // After a URL character the hosted link is part of a longer URL, such as a redirect target.
    String.raw`(?<![A-Za-z0-9%/?#=&@+-])(?<bare>${HOSTED_LINK})(?![\w%/?#-])`,
  ].join("|"),
  "gm",
);

const decodeThreadId = Schema.decodeUnknownOption(ThreadId);
const decodeEnvironmentId = Schema.decodeUnknownOption(EnvironmentId);

function* listFences(
  node: Root | RootContent,
  markdown: string,
  inList = false,
): Generator<{ start: number; end: number }> {
  switch (node.type) {
    case "code": {
      const start = node.position?.start.offset;
      const end = node.position?.end.offset;
      if (
        inList &&
        start !== undefined &&
        end !== undefined &&
        (markdown[start] === "`" || markdown[start] === "~")
      ) {
        yield { start, end };
      }
      break;
    }
    case "root":
    case "blockquote":
    case "list":
    case "listItem":
      for (const child of node.children) {
        yield* listFences(child, markdown, inList || node.type === "listItem");
      }
      break;
  }
}

function* threadLinksIn(markdown: string) {
  if (!hasThreadLinks(markdown)) return;
  const pattern = new RegExp(THREAD_LINK_OUTSIDE_CODE);
  function* scan(start: number, end: number) {
    const prose = markdown.slice(start, end);
    // Hermes' matchAll omits named groups; exec keeps them.
    for (let match = pattern.exec(prose); match !== null; match = pattern.exec(prose)) {
      const groups = match.groups;
      const href = groups?.angleHref ?? groups?.href ?? groups?.autolink ?? groups?.bare;
      const link = href === undefined ? null : parseThreadLinkHref(href);
      if (link !== null) {
        yield {
          link,
          label: groups?.label,
          start: start + match.index,
          end: start + pattern.lastIndex,
        };
      }
    }
  }

  let start = 0;
  // A list fence ends with its item, even without a closing marker. Use the Markdown parser
  // for those boundaries and keep the link scanner's fast path for text without list fences.
  if (FENCE.test(markdown) && POSSIBLE_LIST.test(markdown)) {
    for (const fence of listFences(markdownParser.parse(markdown), markdown)) {
      yield* scan(start, fence.start);
      start = fence.end;
    }
  }
  yield* scan(start, markdown.length);
}

/** A v1 link names no environment; the message's own, or a unique match, stands in. */
export interface ThreadLink {
  readonly environmentId: EnvironmentId | null;
  readonly threadId: ThreadId;
}

// Escapes even URL-safe punctuation, so a sentence's closing period never reads as part of an id.
const hostedSegment = (id: string) =>
  encodeURIComponent(id).replace(
    /[.!~*'()]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );

/** Opens the thread from anywhere: the hosted app offers the desktop app, the mobile app, or itself. */
export function hostedThreadLink(ref: ScopedThreadRef, origin = DEFAULT_HOSTED_APP_URL): string {
  const path = `/threads/${hostedSegment(ref.environmentId)}/${hostedSegment(ref.threadId)}`;
  return new URL(path, origin).toString();
}

const HOSTED_PATH = new RegExp(`^(${HOSTED_SEGMENT})/(${HOSTED_SEGMENT})$`);

function parseHostedThreadLink(href: string): ThreadLink | null {
  const match = HOSTED_PATH.exec(href.slice(HOSTED_PREFIX.length));
  if (!match) return null;
  try {
    const environmentId = Option.getOrNull(decodeEnvironmentId(decodeURIComponent(match[1]!)));
    const threadId = Option.getOrNull(decodeThreadId(decodeURIComponent(match[2]!)));
    return environmentId === null || threadId === null ? null : { environmentId, threadId };
  } catch {
    return null;
  }
}

/**
 * The ids as written. Thread ids can hold percent escapes of their own, so they are not decoded,
 * except in a hosted link, which escapes them itself.
 */
export function parseThreadLinkHref(href: string): ThreadLink | null {
  if (href.startsWith(HOSTED_PREFIX)) return parseHostedThreadLink(href);
  if (href.startsWith(V1_PREFIX)) {
    const threadId = Option.getOrNull(decodeThreadId(href.slice(V1_PREFIX.length)));
    return threadId === null ? null : { environmentId: null, threadId };
  }
  if (!href.startsWith(V2_PREFIX)) return null;
  const path = href.slice(V2_PREFIX.length);
  const slash = path.indexOf("/");
  if (slash < 0) return null;
  const environmentId = Option.getOrNull(decodeEnvironmentId(path.slice(0, slash)));
  const threadId = Option.getOrNull(decodeThreadId(path.slice(slash + 1)));
  return environmentId === null || threadId === null ? null : { environmentId, threadId };
}

function percentDecodedThreadLinkId(threadId: ThreadId): ThreadId | null {
  try {
    const decoded = decodeURIComponent(threadId);
    return decoded === threadId ? null : Option.getOrNull(decodeThreadId(decoded));
  } catch {
    return null;
  }
}

/** The threads a link can name, in its own environment or else the message's: as written, then decoded. */
export function threadLinkCandidates(
  link: ThreadLink,
  messageEnvironmentId: EnvironmentId,
): ReadonlyArray<ScopedThreadRef> {
  const environmentId = link.environmentId ?? messageEnvironmentId;
  const decodedId = percentDecodedThreadLinkId(link.threadId);
  const written = { environmentId, threadId: link.threadId };
  return decodedId === null ? [written] : [written, { environmentId, threadId: decodedId }];
}

/** A v1 link its message's environment lacks opens a unique match elsewhere; a v2 link never does. */
export function guessThreadLinkRef(
  link: ThreadLink,
  refs: ReadonlyArray<ScopedThreadRef>,
): ScopedThreadRef | null {
  if (link.environmentId !== null) return null;
  const decodedId = percentDecodedThreadLinkId(link.threadId);
  for (const threadId of decodedId === null ? [link.threadId] : [link.threadId, decodedId]) {
    let match: ScopedThreadRef | null = null;
    for (const ref of refs) {
      if (ref.threadId !== threadId) continue;
      if (match !== null) return null;
      match = ref;
    }
    if (match !== null) return match;
  }
  return null;
}

function threadLinkHref(link: ThreadLink): string {
  return link.environmentId === null
    ? `${V1_PREFIX}${link.threadId}`
    : `${V2_PREFIX}${link.environmentId}/${link.threadId}`;
}

const linkLabel = (label: string | undefined) =>
  label
    ?.replace(/[[\]\\\r\n]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/** Without a label, an autolink: clients show the thread's current title. */
export function formatThreadLink(ref: ThreadLink, label?: string): string {
  const cleaned = linkLabel(label);
  const href = threadLinkHref(ref);
  const destination = /[()]/.test(href) ? `<${href}>` : href;
  return cleaned ? `[${cleaned}](${destination})` : `<${href}>`;
}

/** What a person copies out of T3 Code: a Markdown link that opens the thread anywhere. */
export function formatHostedThreadLink(
  ref: ScopedThreadRef,
  label: string,
  origin?: string,
): string {
  const href = hostedThreadLink(ref, origin);
  const cleaned = linkLabel(label);
  return cleaned ? `[${cleaned}](${href})` : href;
}

export function hasThreadLinks(markdown: string): boolean {
  return markdown.includes(`${THREAD_LINK_PROTOCOL}://v`) || markdown.includes(HOSTED_PREFIX);
}

/** Every thread the markdown's links can name, so their titles are keyed reads. */
export function threadLinkRefs(
  markdown: string,
  messageEnvironmentId: EnvironmentId,
): ReadonlyArray<ScopedThreadRef> {
  const refs = new Map<string, ScopedThreadRef>();
  for (const { link } of threadLinksIn(markdown)) {
    for (const ref of threadLinkCandidates(link, messageEnvironmentId)) {
      refs.set(`${ref.environmentId}/${ref.threadId}`, ref);
    }
  }
  return [...refs.values()];
}

/** Rewrites each link outside code `replace` answers for. `label` is a Markdown link's own text. */
export function replaceThreadLinks(
  markdown: string,
  replace: (link: ThreadLink, label: string | undefined) => string | undefined,
): string {
  const parts: string[] = [];
  let cursor = 0;
  for (const { link, label, start, end } of threadLinksIn(markdown)) {
    const replacement = replace(link, label);
    if (replacement === undefined) continue;
    parts.push(markdown.slice(cursor, start), replacement);
    cursor = end;
  }
  parts.push(markdown.slice(cursor));
  return parts.join("");
}
