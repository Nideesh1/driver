"""
Type-stripping, in the server, so a browser can import the library's `.ts`
files unchanged.

The problem this solves: driverkit's packages are TypeScript and they import
each other with explicit `.ts` specifiers (`from "../../core/src/types.ts"`).
A browser will happily fetch those URLs — it routes on the MIME type, not the
extension — but it cannot parse `const x: string = "a"`. There is no build step
in this example and no bundler to add one, so something has to remove the types
between the file on disk and the response body. That something is here.

WHY A STRIPPER AND NOT A TRANSPILER. Type erasure is all that is needed:
driverkit's source deliberately contains no `enum`, no `namespace`, no
parameter properties, no decorators and no generic functions — every TS
construct in it is pure annotation, which means the correct output is the input
with some spans deleted. Nothing is rewritten, no code moves, and line numbers
are preserved exactly (every deleted span keeps its newlines), so a stack trace
in the browser console points at the real line of the real `.ts` file.

HOW. A small scanner produces tokens — comments, strings, template literals,
regex literals, punctuators, names, numbers — and a second pass walks them and
drops the type-only ones:

  * `import type …` / `export type …` statements, whole.
  * `interface X { … }` declarations, brace-balanced.
  * `type X = …;` aliases, to the semicolon.
  * `: T` annotations on parameters, variables and return positions.
  * `as T` and `satisfies T` assertions.
  * `?` optional-parameter markers.
  * `<T, U>` type arguments at `new`/call sites.
  * `!` non-null assertions.

The two genuinely ambiguous characters in TypeScript are `:` and `<`, and both
are resolved structurally rather than by regex:

  `:` — a frame stack records, for every open bracket, whether it is a block or
  an object literal, and how many unmatched ternary `?`s are outstanding. A `:`
  belongs to a ternary if one is outstanding, to a property if the frame is an
  object literal, and otherwise it is an annotation. (`=> {` is always a block
  in JavaScript — an object literal there needs parentheses — which is what
  makes the block/object test decidable without a parser.)

  `<` — a trial balanced scan runs over the following tokens and accepts only
  type-shaped ones. If the scan closes and the token after it is `(`, these were
  type arguments; otherwise the `<` was a less-than and is emitted untouched.
  `>>` closing two nested angles is handled by consuming the `>` characters of a
  single token one at a time, which is also why `>>> 0` in the core's
  fingerprint survives.

This is not a TypeScript compiler and makes no attempt to be. It is checked by
executing its output: see `verify_strip.py`, which strips every package file,
runs the result under plain Node with no type-stripping flag, and compares the
behaviour of a mounted driver against the same script run on the original `.ts`
sources via `node --experimental-strip-types`.
"""

from __future__ import annotations

import re

__all__ = ["strip_types"]

# --- the scanner ----------------------------------------------------------

#: Longest-first, so `>>>` wins over `>>` and `?.` over `?`.
PUNCT = sorted(
    [
        ">>>=", "...", "===", "!==", "**=", "<<=", ">>=", ">>>",
        "=>", "==", "!=", "<=", ">=", "&&", "||", "??", "?.", "++", "--",
        "+=", "-=", "*=", "/=", "%=", "&=", "|=", "^=", "**", "<<", ">>",
        "&&=", "||=", "??=",
        "{", "}", "(", ")", "[", "]", ";", ",", ":", "?", ".", "<", ">",
        "=", "+", "-", "*", "/", "%", "&", "|", "^", "!", "~", "@", "#",
    ],
    key=len,
    reverse=True,
)

NAME_RE = re.compile(r"[A-Za-z_$][A-Za-z0-9_$]*")
NUM_RE = re.compile(r"0[xXbBoO][0-9a-fA-F_]+n?|[0-9][0-9_]*(\.[0-9_]*)?([eE][+-]?[0-9]+)?n?|\.[0-9][0-9_]*")

#: After one of these a `/` starts a regex literal and `!` is a prefix `not`.
#: Keywords are in here because `return !x` and `typeof /re/` are both legal.
OPERAND_END_KEYWORDS = {
    "return", "typeof", "void", "delete", "in", "of", "instanceof", "new",
    "do", "else", "yield", "await", "throw", "case", "default", "extends",
}

WS = "ws"
COMMENT = "comment"
STR = "str"
TMPL = "tmpl"
REGEX = "regex"
PUNCT_K = "punct"
NAME = "name"
NUM = "num"


class Tok:
    __slots__ = ("kind", "text")

    def __init__(self, kind: str, text: str) -> None:
        self.kind = kind
        self.text = text

    def __repr__(self) -> str:  # pragma: no cover - debugging only
        return f"Tok({self.kind},{self.text!r})"


def _scan_string(src: str, i: int) -> int:
    quote = src[i]
    i += 1
    while i < len(src):
        c = src[i]
        if c == "\\":
            i += 2
            continue
        if c == quote:
            return i + 1
        i += 1
    raise ValueError("unterminated string")


def _scan_template(src: str, i: int) -> int:
    """A whole template literal, including any `${…}` expressions, as one span.

    Opaque on purpose. Nothing in driverkit puts a type assertion inside an
    interpolation, and treating the template as one token is what keeps the
    widget's CSS — a hundred and fifty lines of braces — from being read as
    code.
    """
    i += 1
    while i < len(src):
        c = src[i]
        if c == "\\":
            i += 2
            continue
        if c == "`":
            return i + 1
        if c == "$" and i + 1 < len(src) and src[i + 1] == "{":
            depth = 1
            i += 2
            while i < len(src) and depth:
                c = src[i]
                if c in "\"'":
                    i = _scan_string(src, i)
                    continue
                if c == "`":
                    i = _scan_template(src, i)
                    continue
                if c == "{":
                    depth += 1
                elif c == "}":
                    depth -= 1
                i += 1
            continue
        i += 1
    raise ValueError("unterminated template")


def _scan_regex(src: str, i: int) -> int:
    i += 1
    in_class = False
    while i < len(src):
        c = src[i]
        if c == "\\":
            i += 2
            continue
        if c == "[":
            in_class = True
        elif c == "]":
            in_class = False
        elif c == "/" and not in_class:
            i += 1
            while i < len(src) and src[i].isalpha():
                i += 1
            return i
        elif c == "\n":
            raise ValueError("unterminated regex")
        i += 1
    raise ValueError("unterminated regex")


def tokenize(src: str) -> list[Tok]:
    out: list[Tok] = []
    i = 0
    n = len(src)

    def prev_significant() -> Tok | None:
        for tok in reversed(out):
            if tok.kind not in (WS, COMMENT):
                return tok
        return None

    while i < n:
        c = src[i]

        if c in " \t\r\n":
            j = i
            while j < n and src[j] in " \t\r\n":
                j += 1
            out.append(Tok(WS, src[i:j]))
            i = j
            continue

        if src.startswith("//", i):
            j = src.find("\n", i)
            j = n if j == -1 else j
            out.append(Tok(COMMENT, src[i:j]))
            i = j
            continue

        if src.startswith("/*", i):
            j = src.find("*/", i + 2)
            j = n if j == -1 else j + 2
            out.append(Tok(COMMENT, src[i:j]))
            i = j
            continue

        if c in "\"'":
            j = _scan_string(src, i)
            out.append(Tok(STR, src[i:j]))
            i = j
            continue

        if c == "`":
            j = _scan_template(src, i)
            out.append(Tok(TMPL, src[i:j]))
            i = j
            continue

        if c == "/":
            prev = prev_significant()
            operand = prev is not None and (
                prev.kind in (NAME, NUM, STR, TMPL, REGEX)
                and not (prev.kind == NAME and prev.text in OPERAND_END_KEYWORDS)
                or (prev.kind == PUNCT_K and prev.text in (")", "]", "}", "++", "--"))
            )
            if not operand:
                j = _scan_regex(src, i)
                out.append(Tok(REGEX, src[i:j]))
                i = j
                continue

        m = NAME_RE.match(src, i)
        if m:
            out.append(Tok(NAME, m.group(0)))
            i = m.end()
            continue

        m = NUM_RE.match(src, i)
        if m:
            out.append(Tok(NUM, m.group(0)))
            i = m.end()
            continue

        for p in PUNCT:
            if src.startswith(p, i):
                out.append(Tok(PUNCT_K, p))
                i += len(p)
                break
        else:
            raise ValueError(f"cannot tokenize {src[i:i+20]!r}")

    return out


# --- the stripper ---------------------------------------------------------

#: After one of these, a `{` opens an object literal rather than a block.
#: `=>` is deliberately absent: `=> {` is always a block in JavaScript, and an
#: object literal in that position has to be parenthesised.
OBJECT_AFTER_PUNCT = {
    "(", ",", "=", ":", "[", "?", "&&", "||", "??", "...", "+", "=>>",
    "+=", "==", "===", "!=", "!==", "return",
}
OBJECT_AFTER_NAME = {"return", "yield", "throw", "case", "do", "typeof", "await"}

#: Tokens a type expression may contain. Used by the trial angle scan.
TYPE_PUNCT = {
    "<", ">", ",", ".", "|", "&", "[", "]", "(", ")", "{", "}", "?", ":",
    "=>", "...", ">>", ">>>", "=",
}

#: Stops a `: T` / `as T` consumption when seen at depth zero.
TYPE_STOP = {",", ";", ")", "]", "}", "=", "=>", "?"}

#: Member and parameter modifiers that exist only for the type checker.
MODIFIERS = {"readonly", "public", "private", "protected", "abstract", "override", "declare"}

BODY_FIRST_KEYWORDS = {
    "const", "let", "var", "return", "if", "for", "while", "do", "switch",
    "throw", "try", "await", "delete", "void", "yield", "function", "class",
    "break", "continue", "debugger", "import", "export", "new",
}


class _Frame:
    __slots__ = ("kind", "ternary", "cases")

    def __init__(self, kind: str) -> None:
        self.kind = kind
        self.ternary = 0
        #: Unmatched `case` labels. Their `:` is punctuation, not an annotation.
        self.cases = 0


def _blank(text: str) -> str:
    """A deleted span, with its newlines kept so line numbers do not move."""
    return "\n" * text.count("\n")


def _strip_in_template(text: str) -> str:
    """Strip types inside a template literal's `${…}` expressions.

    The scanner treats a template as one opaque span so that the widget's
    stylesheet — a hundred and fifty lines of braces — is not read as code. But
    an interpolation is real code and can hold a cast, so each one is stripped
    on its own here.
    """
    out: list[str] = []
    i = 0
    n = len(text)
    while i < n:
        c = text[i]
        if c == "\\":
            out.append(text[i : i + 2])
            i += 2
            continue
        if c == "$" and i + 1 < n and text[i + 1] == "{":
            depth = 1
            j = i + 2
            start = j
            while j < n and depth:
                d = text[j]
                if d in "\"'":
                    j = _scan_string(text, j)
                    continue
                if d == "`":
                    j = _scan_template(text, j)
                    continue
                if d == "{":
                    depth += 1
                elif d == "}":
                    depth -= 1
                    if depth == 0:
                        break
                j += 1
            inner = text[start:j]
            out.append("${" + strip_types(inner) + "}")
            i = j + 1
            continue
        out.append(c)
        i += 1
    return "".join(out)


def strip_types(src: str) -> str:
    toks = tokenize(src)
    n = len(toks)
    out: list[str] = []
    stack = [_Frame("block")]

    def nxt(i: int) -> int:
        """Index of the next significant token after `i`, or `n`."""
        j = i + 1
        while j < n and toks[j].kind in (WS, COMMENT):
            j += 1
        return j

    def first_sig(i: int) -> int:
        j = i
        while j < n and toks[j].kind in (WS, COMMENT):
            j += 1
        return j

    def emit_blank(a: int, b: int) -> None:
        """Delete tokens [a, b), keeping comments and newlines."""
        for k in range(a, b):
            t = toks[k]
            if t.kind == COMMENT:
                out.append(t.text)
            elif t.kind == WS:
                out.append(t.text)
            else:
                out.append(_blank(t.text))

    # -- span finders ------------------------------------------------------

    def end_of_statement(i: int) -> int:
        """Index just past the `;` ending the statement that starts at `i`."""
        depth = 0
        j = i
        while j < n:
            t = toks[j]
            if t.kind == PUNCT_K:
                if t.text in "{([":
                    depth += 1
                elif t.text in "})]":
                    depth -= 1
                elif t.text == ";" and depth <= 0:
                    return j + 1
            j += 1
        return n

    def end_of_braced_decl(i: int) -> int:
        """Index just past the `}` of `interface X { … }` (plus a stray `;`)."""
        j = i
        while j < n and not (toks[j].kind == PUNCT_K and toks[j].text == "{"):
            j += 1
        depth = 0
        while j < n:
            t = toks[j]
            if t.kind == PUNCT_K:
                if t.text == "{":
                    depth += 1
                elif t.text == "}":
                    depth -= 1
                    if depth == 0:
                        j += 1
                        k = first_sig(j)
                        if k < n and toks[k].kind == PUNCT_K and toks[k].text == ";":
                            return k + 1
                        return j
            j += 1
        return n

    def looks_like_object_type(i: int) -> bool:
        """`{` at `i`: an object *type* literal, or a function body?

        Only asked in a return-type position, where both are possible —
        `function f(): { title?: string } { … }` has one of each. A type literal
        starts `name ?` or `name :`; a body starts with a statement.
        """
        a = first_sig(i + 1)
        if a >= n:
            return False
        if toks[a].kind == PUNCT_K and toks[a].text == "}":
            return True
        if toks[a].kind != NAME and toks[a].kind != STR:
            return False
        if toks[a].kind == NAME and toks[a].text in BODY_FIRST_KEYWORDS:
            return False
        b = first_sig(a + 1)
        return b < n and toks[b].kind == PUNCT_K and toks[b].text in ("?", ":")

    def end_of_type(i: int, is_return: bool) -> int:
        """Index just past a type expression beginning at `i`."""
        depth = 0
        j = i
        last = ""
        while j < n:
            t = toks[j]
            if t.kind in (WS, COMMENT):
                j += 1
                continue
            if t.kind == PUNCT_K:
                # `=>` at depth zero continues the type only when a
                # parenthesised parameter list just closed, i.e. the type is a
                # function type like `(err: unknown) => void`. Everywhere else
                # it is the arrow of the function whose return type this is.
                if t.text == "=>" and depth == 0 and last == ")":
                    last = t.text
                    j += 1
                    continue
                if t.text in ("(", "[", "{"):
                    if t.text == "{" and depth == 0 and is_return and not looks_like_object_type(j):
                        return j
                    depth += 1
                    last = t.text
                    j += 1
                    continue
                if t.text in (")", "]", "}"):
                    if depth == 0:
                        return j
                    depth -= 1
                    last = t.text
                    j += 1
                    continue
                if t.text == "<":
                    depth += 1
                    last = t.text
                    j += 1
                    continue
                if set(t.text) == {">"}:
                    depth = max(0, depth - len(t.text))
                    last = ">"
                    j += 1
                    continue
                if depth == 0 and t.text in TYPE_STOP:
                    return j
                last = t.text
                j += 1
                continue
            last = t.text
            j += 1
        return n

    def type_args_end(i: int) -> int:
        """`<` at `i`: index just past the matching `>` if these are type
        arguments at a call site, else -1."""
        depth = 0
        braces = 0
        j = i
        while j < n:
            t = toks[j]
            if t.kind in (WS, COMMENT):
                j += 1
                continue
            if t.kind in (NAME, STR, NUM):
                j += 1
                continue
            if t.kind == PUNCT_K and t.text == "{":
                braces += 1
                j += 1
                continue
            if t.kind == PUNCT_K and t.text == "}":
                braces -= 1
                j += 1
                continue
            if t.kind == PUNCT_K and t.text == ";":
                # A member separator inside an object type. Allowed only there:
                # a bare `;` would let `for (i = 0; i < n; i++)` be mistaken
                # for type arguments.
                if braces <= 0:
                    return -1
                j += 1
                continue
            if t.kind != PUNCT_K or t.text not in TYPE_PUNCT:
                return -1
            if t.text == "<":
                depth += 1
                j += 1
                continue
            if set(t.text) == {">"}:
                depth -= len(t.text)
                j += 1
                if depth == 0:
                    k = first_sig(j)
                    # Type arguments are only unambiguous when a call follows.
                    if k < n and toks[k].kind == PUNCT_K and toks[k].text == "(":
                        return j
                    return -1
                if depth < 0:
                    return -1
                continue
            j += 1
        return -1

    # -- the walk ----------------------------------------------------------

    def prev_sig_emitted(i: int) -> Tok | None:
        for k in range(i - 1, -1, -1):
            if toks[k].kind not in (WS, COMMENT):
                return toks[k]
        return None

    i = 0
    # True while inside an `import …` / `export …` clause, where a `type`
    # before a name is an inline type-only specifier and not a value.
    in_clause = False
    while i < n:
        t = toks[i]

        if t.kind in (WS, COMMENT):
            out.append(t.text)
            i += 1
            continue

        if t.kind == NAME:
            if in_clause and t.text == "type":
                # `import { createServer, type Server } from "node:http"` — an
                # inline type-only specifier. Recognised only directly after
                # `{` or `,` inside a clause, so a value named `type` is safe.
                prev = prev_sig_emitted(i)
                j = nxt(i)
                if (
                    prev is not None
                    and prev.kind == PUNCT_K
                    and prev.text in ("{", ",")
                    and j < n
                    and toks[j].kind == NAME
                ):
                    # The whole specifier goes, not just the `type` keyword:
                    # leaving the name behind turns a type-only import into a
                    # runtime import of an export that does not exist.
                    end = nxt(j)
                    if end < n and toks[end].kind == NAME and toks[end].text == "as":
                        end = nxt(nxt(end))
                    # Take the trailing comma with it, or the leading one when
                    # this was the last specifier in the clause.
                    if end < n and toks[end].kind == PUNCT_K and toks[end].text == ",":
                        end += 1
                    elif end < n and toks[end].kind == PUNCT_K and toks[end].text == "}":
                        for k in range(len(out) - 1, -1, -1):
                            if out[k] == ",":
                                out[k] = ""
                                break
                            if out[k].strip():
                                break
                    emit_blank(i, end)
                    i = end
                    continue

            if t.text in ("case", "default"):
                # A `case "hello":` label's colon is punctuation. Without this
                # it reads as a return-type annotation and the whole case body
                # is deleted — which is exactly what happened to the relay.
                stack[-1].cases += 1

            if t.text == "implements":
                # `class X implements A, B {` — drop the clause up to the body.
                j = i
                while j < n and not (toks[j].kind == PUNCT_K and toks[j].text == "{"):
                    j += 1
                emit_blank(i, j)
                i = j
                continue

            if t.text in MODIFIERS:
                prev = prev_sig_emitted(i)
                j = nxt(i)
                member_start = prev is None or (
                    prev.kind == PUNCT_K and prev.text in ("{", "}", ";", "(", ",")
                )
                follows_name = j < n and (
                    toks[j].kind in (NAME, STR, NUM)
                    or (toks[j].kind == PUNCT_K and toks[j].text in ("[", "#"))
                )
                if member_start and follows_name:
                    out.append("")
                    i += 1
                    continue

            if t.text in ("import", "export"):
                in_clause = True
                j = nxt(i)
                if j < n and toks[j].kind == NAME and toks[j].text == "type":
                    k = nxt(j)
                    # `export type {…}` / `export type X = …` / `import type …`
                    # — but not `export type` as a property name, which cannot
                    # happen at statement level.
                    if k < n:
                        end = end_of_statement(i)
                        emit_blank(i, end)
                        i = end
                        continue
                if j < n and toks[j].kind == NAME and toks[j].text == "interface":
                    end = end_of_braced_decl(j)
                    emit_blank(i, end)
                    i = end
                    continue
                if j < n and toks[j].kind == NAME and toks[j].text == "declare":
                    end = end_of_statement(i)
                    emit_blank(i, end)
                    i = end
                    continue
                out.append(t.text)
                i += 1
                continue

            if t.text == "interface":
                end = end_of_braced_decl(i)
                emit_blank(i, end)
                i = end
                continue

            if t.text == "type":
                # A type alias, as opposed to a variable named `type` or a
                # property key. Only a `name =` can follow a `type` keyword.
                j = nxt(i)
                k = nxt(j) if j < n else n
                if (
                    j < n
                    and toks[j].kind == NAME
                    and k < n
                    and toks[k].kind == PUNCT_K
                    and toks[k].text in ("=", "<")
                ):
                    end = end_of_statement(i)
                    emit_blank(i, end)
                    i = end
                    continue

            if t.text in ("as", "satisfies"):
                j = nxt(i)
                end = end_of_type(j, is_return=False)
                emit_blank(i, end)
                i = end
                continue

            out.append(t.text)
            i += 1
            continue

        if t.kind == PUNCT_K:
            text = t.text

            if text == ";":
                in_clause = False

            if text in ("(", "["):
                in_clause = False
                stack.append(_Frame("paren" if text == "(" else "bracket"))
                out.append(text)
                i += 1
                continue

            if text == "{":
                prev = prev_sig_emitted(i)
                kind = "block"
                if prev is not None:
                    if prev.kind == PUNCT_K and prev.text in OBJECT_AFTER_PUNCT:
                        kind = "object"
                    elif prev.kind == NAME and prev.text in OBJECT_AFTER_NAME:
                        kind = "object"
                stack.append(_Frame(kind))
                out.append(text)
                i += 1
                continue

            if text in (")", "]", "}"):
                if len(stack) > 1:
                    stack.pop()
                out.append(text)
                i += 1
                continue

            if text == "?":
                j = nxt(i)
                if j < n and toks[j].kind == PUNCT_K and toks[j].text in (":", ",", ")"):
                    # An optional parameter marker. The `:` that may follow is
                    # then an annotation and is handled on the next iteration.
                    out.append("")
                    i += 1
                    continue
                stack[-1].ternary += 1
                out.append(text)
                i += 1
                continue

            if text == ":":
                frame = stack[-1]
                if frame.ternary > 0:
                    frame.ternary -= 1
                    out.append(text)
                    i += 1
                    continue
                if frame.cases > 0:
                    frame.cases -= 1
                    out.append(text)
                    i += 1
                    continue
                if frame.kind == "object":
                    out.append(text)
                    i += 1
                    continue
                prev = prev_sig_emitted(i)
                is_return = prev is not None and prev.kind == PUNCT_K and prev.text == ")"
                j = nxt(i)
                end = end_of_type(j, is_return=is_return)
                emit_blank(i, end)
                i = end
                continue

            if text == "<":
                prev = prev_sig_emitted(i)
                if prev is not None and (
                    prev.kind == NAME and prev.text not in OPERAND_END_KEYWORDS
                ):
                    end = type_args_end(i)
                    if end != -1:
                        emit_blank(i, end)
                        i = end
                        continue
                out.append(text)
                i += 1
                continue

            if text == "!":
                prev = prev_sig_emitted(i)
                postfix = prev is not None and (
                    (prev.kind == NAME and prev.text not in OPERAND_END_KEYWORDS)
                    or prev.kind in (NUM, STR, TMPL)
                    or (prev.kind == PUNCT_K and prev.text in (")", "]"))
                )
                if postfix:
                    out.append("")
                    i += 1
                    continue
                out.append(text)
                i += 1
                continue

            out.append(text)
            i += 1
            continue

        if t.kind == TMPL:
            out.append(_strip_in_template(t.text))
            i += 1
            continue

        out.append(t.text)
        i += 1

    return "".join(out)
