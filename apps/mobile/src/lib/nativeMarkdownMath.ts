import type { Extension, State, TokenizeContext, Tokenizer } from "micromark-util-types";
import type { Processor } from "unified";

declare module "micromark-util-types" {
  interface TokenTypeMap {
    nativeMath: "nativeMath";
    nativeMathData: "nativeMathData";
    nativeMathLineEnding: "nativeMathLineEnding";
  }
}

const dollar = "$".charCodeAt(0);
const backslash = "\\".charCodeAt(0);
const openParen = "(".charCodeAt(0);
const openBracket = "[".charCodeAt(0);
const closeParen = ")".charCodeAt(0);
const closeBracket = "]".charCodeAt(0);
const wordCharacter = /[\p{L}\p{N}]/u;
const unterminatedBrackets = new WeakMap<TokenizeContext, Set<number>>();

function isWord(code: number | null): boolean {
  return code !== null && code > 0 && wordCharacter.test(String.fromCodePoint(code));
}

// md4c treats even display math as an inline span. Let Markdown establish the blocks first.
const tokenizeMath: Tokenizer = function (effects, ok, nok) {
  let width = 0;
  let closingWidth = 0;
  let bracket: number | undefined;
  const context = this;
  const previous = context.previous;
  return start;

  function start(code: number | null) {
    if (code === dollar && (previous === dollar || isWord(previous))) return nok(code);
    effects.enter("nativeMath");
    effects.enter("nativeMathData");
    effects.consume(code);
    if (code === backslash) return openingBracket;
    width = 1;
    return openingDollars;
  }

  function openingBracket(code: number | null) {
    if (code !== openParen && code !== openBracket) return nok(code);
    bracket = code === openParen ? closeParen : closeBracket;
    if (unterminatedBrackets.get(context)?.has(bracket)) return nok(code);
    effects.consume(code);
    return body;
  }

  function openingDollars(code: number | null) {
    if (code !== dollar) return body(code);
    if (++width > 2) return nok(code);
    effects.consume(code);
    return openingDollars;
  }

  function body(code: number | null): State | undefined {
    if (code === null) return unterminated(code);
    if (bracket === undefined && code === dollar) return closingDollars(code);
    // Micromark uses separate events for line endings within multi-line inline spans.
    if (code === -5 || code === -4 || code === -3) {
      effects.exit("nativeMathData");
      return nextLine(code);
    }
    effects.consume(code);
    return code === backslash ? escaped : body;
  }

  function nextLine(code: number | null): State | undefined {
    if (code === -5 || code === -4 || code === -3) {
      effects.enter("nativeMathLineEnding");
      effects.consume(code);
      effects.exit("nativeMathLineEnding");
      return nextLine;
    }
    if (code === null) return unterminated(code);
    effects.enter("nativeMathData");
    return body(code);
  }

  function unterminated(code: null) {
    if (bracket !== undefined) {
      // No closer remains in this inline context, including after any later opener.
      const brackets = unterminatedBrackets.get(context) ?? new Set<number>();
      brackets.add(bracket);
      unterminatedBrackets.set(context, brackets);
    }
    return nok(code);
  }

  function escaped(code: number | null) {
    if (code === bracket) {
      effects.consume(code);
      effects.exit("nativeMathData");
      effects.exit("nativeMath");
      return ok;
    }
    if (code !== dollar && code !== backslash) return body(code);
    effects.consume(code);
    return body;
  }

  function closingDollars(code: number | null): State | undefined {
    if (code === dollar) {
      closingWidth += 1;
      effects.consume(code);
      return closingDollars;
    }
    if (closingWidth > 2) {
      closingWidth = 0;
      return body(code);
    }
    if (closingWidth !== width || isWord(code)) return nok(code);
    effects.exit("nativeMathData");
    effects.exit("nativeMath");
    return ok(code);
  }
};

const math = { tokenize: tokenizeMath };
const extension: Extension = { text: { [dollar]: math, [backslash]: math } };

/** Keep formula contents opaque to image discovery. */
export const remarkNativeMarkdownMath = function (this: Processor) {
  (this.data().micromarkExtensions ??= []).push(extension);
};
