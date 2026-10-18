# Companion Rules — Language-Neutral Behavioural Specification

**Document ID:** `companion-rules`
**Version:** 1.0.0 (v1)
**Status:** Stable draft for independent reimplementation.
**Date:** 2026-10-18
**Audience:** implementers of *Lectern* (a closed-source Python project) and maintainers of the reference tool that first encoded these rules.

---

## Front matter

### What this document is

A precise, **language-neutral** description of the behaviour of the file-naming, book-identification, filesystem-safety, embedded-metadata, metadata-validation, provider-merge, duplicate-detection, review/approval and media-type rules of a media-management companion tool. It is written so that a Python developer can implement every rule **from this text alone**, without reading the original implementation.

It contains no source code, no Node/Python APIs, and no library-specific instructions. Algorithms are given as plain pseudocode.

### What this document is not

- It is **not** a data-model specification. It does not describe tables, columns or the wider product.
- It is **not** the external-provider HTTP layer (search/fetch/rate-limit/attribution). Only the pure *merge* rule is specified here.
- It does **not** include the integration hacks that exist purely to satisfy one particular downstream reader. Those are listed, and explicitly excluded, in [§9 Deliberately not specified](#9-deliberately-not-specified).

### Provenance and clean-room statement

This specification was produced under a clean-room discipline. It is derived from **observed behaviour and agreed acceptance-test expectations** of a companion tool; no third-party (GPL) source code was read, copied, translated or ported, and no third-party source symbol or file path is cited here. Where the original implementation was internally inconsistent, this document states the **intended** behaviour and marks the divergence. Nothing in this document is a derivative work of any copyleft project.

### Licence

The project owner intends this document to be released under a **permissive, non-copyleft licence** so that it can be consumed by a closed-source project. The recommended choice is **CC0-1.0** (public-domain dedication). Until the owner confirms, treat this document as *all rights reserved*. The accompanying conformance corpus ([§10](#10-conformance)) is intended to carry the same licence.

### How to use this document

1. Implement each rule from its **statement**, **algorithm** and **worked example**.
2. Every rule has a **rule ID** (e.g. `N1`, `P1`, `M4`). Use the IDs to map your implementation and your tests to this document, and to report divergences.
3. A **machine-readable conformance corpus** of `(input → expected output)` cases will accompany this document. Both the reference tool and your implementation should run it. **Where the corpus and this text disagree, this text wins** (see [§10](#10-conformance)).
4. Where this document says **"Intended"**, that is the behaviour to implement, even if the reference tool currently behaves differently. Those points are collected in [§0.5](#05-current-vs-intended-decisions).
5. Text primitives (normalisation, digit classes, comparison semantics) are defined once in [§0](#0-text-primitives-and-traps) and referenced by every rule. Read [§0](#0-text-primitives-and-traps) first.

---

## 0. Text primitives and traps

These primitives apply to **every** rule below. They exist because the reference implementation is written in a JavaScript runtime and the target is Python; several operations have no exact cross-language equivalent and would silently diverge if translated naively.

### 0.1 Normalisation

- **NFC.** Before any rule touches a string that will become a name, it is normalised to Unicode **NFC**. Implement with the platform's Unicode normaliser (`unicodedata.normalize("NFC", s)` in Python).
- All matching is then performed on the NFC form. Output names are NFC.

### 0.2 Digit classes — ASCII only

All numeric patterns in this document use **ASCII digits `0`–`9` only**.

> **Trap.** In JavaScript, `\d` (without the `u` flag) means `[0-9]`. In Python, `\d` on a `str` pattern matches **any Unicode decimal digit** (e.g. Arabic-Indic `٠١٢`, Devanagari, fullwidth). If you translate a pattern verbatim, a filename containing a non-ASCII digit could match where the reference would not.
> **Intended:** every number in every rule is `[0-9]`. Write `[0-9]` explicitly, or compile with `re.ASCII`.

### 0.3 Whitespace

`\s` means **Unicode whitespace** (space, tab, newline, form feed, non-breaking space and the other characters in the Unicode `White_Space` property).

> **Trap.** JavaScript's `\s` and Python's `\s` are close but not identical, and Python's `str.split()`/`str.strip()` have their own definitions.
> **Intended:** treat as whitespace the Unicode `White_Space` set. When in doubt, normalise the string's internal whitespace by collapsing runs of `White_Space` to a single ASCII space.

### 0.4 Comparison semantics

Two distinct string comparisons appear:

- **`accent`-sensitive equality** — used to decide whether two series names are *the same series*. Case is ignored; accents are **not**.
  > **Trap.** The reference uses a locale-aware comparator (`localeCompare(..., {sensitivity:"accent"})`). Its result depends on the runtime's default locale, which can vary between machines.
  > **Intended:** equality that ignores letter case but preserves accents, **independent of locale**. Implement as a case-insensitive comparison of code points (e.g. `a.casefold() == b.casefold()`); do **not** apply locale-specific collation rules.
- **Natural (numeric) ordering** — used to order pages and series lists. See [§0.5](#05-current-vs-intended-decisions) and the algorithm in [§3.4](#34-natural-order-p3).

### 0.5 Current-vs-intended decisions

The reference implementation has a small number of internal inconsistencies and cross-language hazards. This specification pins the intended behaviour. Implement the **intended** column.

| # | Area | Current (reference) | **Intended (implement this)** | Where |
|---|---|---|---|---|
| D1 | Media-type mapping | Library-type enum literals duplicated in ≥4 places; has shipped two bugs (a no-op volume filter; a book-only guard applied inconsistently) | **One** total mapping from library type → media class, defined in [§8](#8-media-type-mapping) | §8 |
| D2 | Metadata validation | Two divergent validators: one **throws** on a limit/vocabulary violation, the other **silently drops** the field; they also disagree on *which* fields are checked | **One** validator with an explicit `accept/reject` contract; rejection is never a silent coercion, and the caller decides whether to surface or skip. [§4.5](#45-unified-field-validation-m7) | §4.5 |
| D3 | `safeSegment` length cap | Caps at 200 **UTF-8 bytes**; the truncation loop removes one UTF-16 code unit at a time (can split an astral character) | Cap at 200 **UTF-8 bytes**; remove whole **Unicode code points** until the cap is met | §3.1 |
| D4 | Case sensitivity | Locale-dependent comparator for series equality | Locale-independent, case-insensitive, accent-sensitive equality | §0.4 |
| D5 | Natural order | `localeCompare(..., {numeric:true, sensitivity:"base"})` — no exact Python equivalent | Explicit natural-sort algorithm: integer-aware digit runs, case- and accent-insensitive | §3.4 |
| D6 | Redundant volume token | Rule duplicated in two languages | One rule (`V5`, `V6`) | §1.5–§1.6 |

---

## 1. Name cleaning (rule family `N`)

These rules turn a scene/release filename or series string into a tidy name. They are **pure string functions**. Filesystem safety is a separate, later step ([§3](#3-filesystem-safe-segments)).

### 1.1 Release-noise vocabulary (`N1`)

A fixed set of lowercase words. A bracketed group whose words are *all* in this set is noise. The set is intentionally short:

```
digital, scan, scans, scanned, scanlation, cbz, cbr, cb7, zip, rar, 7z,
epub, mobi, azw3, repack, repacks, fixed, complete, c2c, noads, retail,
webrip, web, hd, sd, remastered, compressed, uncensored, decensored,
ongoing, ocr, empire, zone, minutemen
```

**Intended:** match is case-insensitive and operates on the group's words.

### 1.2 `isNoiseGroup(inner)` (`N2`)

**Statement.** Decide whether the text inside one bracketed group is release noise (and should therefore be removed) or meaningful content (and should be kept).

**Algorithm.**

```
function isNoiseGroup(inner):
    text = trim(inner)
    if text == "": return true                      # "()" or "[]"

    # bare year, or a year range
    if matches(text, r"^[0-9]{4}\s*[-–]\s*[0-9]{4}$"): return true   # (1968-1996)
    if matches(text, r"^[0-9]{4}$"):                    return true   # (2020)

    # every word is a release-noise word
    words = non_empty( lower(text).split_on(not [a-z0-9]) )
    if words not empty and every w in words is in RELEASE_WORDS: return true

    # "shouty" unknown scanner group:
    #   short, no sentence punctuation, and one of:
    #     a digit / separator, an acronym run, or an internal capital
    return length(text) <= 24
       and text has none of: . , ! ? ' ’
       and ( text contains an ASCII digit [0-9]
             or text contains any of: _ + - –        # separators
             or matches(text, r"[A-Z]{2,}")           # acronym run, e.g. -KS-
             or matches(text, r"\p{Lu}\p{Ll}*\p{Lu}") )  # internal capital, e.g. LuCaZ
```

- `–` is the **en dash** U+2013.
- `\p{Lu}` = a Unicode **uppercase letter** (general category `Lu`); `\p{Ll}` = a Unicode **lowercase letter** (`Ll`). The internal-capital pattern means: an uppercase letter, then zero or more lowercase letters, then another uppercase letter.
  > **Trap.** Python's `re` module does not support `\p{...}` properties. Use the `regex` module, or implement the two property classes directly: "uppercase letter" = a character whose Unicode general category is `Lu`; "lowercase letter" = category `Ll`.
- The word-splitting for the `RELEASE_WORDS` test splits on any run of characters that is **not** `[a-z0-9]` (ASCII), after lower-casing.

**Worked examples.**

| `inner` | Result | Why |
|---|---|---|
| `Digital` | noise | word `digital` ∈ vocabulary |
| `Digital-Empire` | noise | words `digital`,`empire` all ∈ vocabulary |
| `Zone-Empire` | noise | words `zone`,`empire` all ∈ vocabulary |
| `LuCaZ` | noise | ≤24 chars, no punctuation, internal capital `L…C` |
| `-KS-` | noise | ≤24 chars, no punctuation, acronym run `KS` |
| `1968-1996` | noise | year range |
| `2020` | noise | bare year |
| `The Faust Act` | keep | has spaces but no digit/separator/acronym/internal-capital |
| `A LitRPG/Gamelit Adventure` | keep | has `/` but no digit; contains lowercase runs; no `[A-Z]{2,}`, no internal capital, and `A LitRPG/Gamelit Adventure` is >24 chars anyway |
| `` (empty) | noise | empty |

### 1.3 `dropOrphanBrackets(input)` (`N3`)

**Statement.** Remove the bracket characters that have no partner, keeping the text that was inside them.

**Algorithm.** Treat the string as a sequence of Unicode **code points**. Maintain a stack of open-bracket positions.

```
function dropOrphanBrackets(input):
    pair = { ")": "(", "]": "[" }
    stack = []
    drop = set()
    for i, ch in enumerate(code_points(input)):
        if ch == "(" or ch == "[": stack.push(i)
        else if ch == ")" or ch == "]":
            if stack not empty and code_points(input)[stack.top()] == pair[ch]:
                stack.pop()
            else:
                drop.add(i)
    for i in stack: drop.add(i)               # unclosed opens
    return join(code_points(input)[i] for i not in drop)
```

- Brackets of **different types** do not pair (`(` only closes with `)`).
- A closer with no matching opener is dropped; an opener with no closer is dropped.
- Text between a dropped pair is **kept**.

> **Trap.** The reference iterates one representation for the stack (UTF-16 code units) and a different one for the filter (Unicode code points). For strings containing astral characters (outside the BMP, e.g. emoji) those indices disagree.
> **Intended:** operate consistently on Unicode **code points**, so a bracket and the character after it are never mis-indexed.

**Worked examples.**

| Input | Result | Why |
|---|---|---|
| `(Saga` | `Saga` | the `(` is unclosed → dropped |
| `Saga)` | `Saga` | the `)` has no opener → dropped |
| `[Solo Leveling` | `Solo Leveling` | the `[` is unclosed → dropped |
| `(a]b)` | `(ab)` | `]` wants `[` but the top of the stack is `(` → `]` dropped; `)` then closes `(` → `)` kept |
| `(a(b)c)` | `(a(b)c)` | all four brackets pair correctly |

### 1.4 `cleanName(input)` (`N4`)

**Statement.** Strip release tags, bare years and orphan brackets from a name segment; collapse whitespace; trim leading/trailing separators. Safe on an already-clean name (returns it unchanged).

**Algorithm.**

```
function cleanName(input):
    s = NFC( input or "" )

    # One left-to-right pass: find each innermost bracketed group and, if it is
    # noise, replace the WHOLE group with a single space.
    # Group pattern:  ( or [   then  (any chars except ( ) [ ])   then  ) or ]
    s = replace_first_match_left_to_right(
            s,
            r"[(\[]( [^()\[\]]* )[]\)]",
            if isNoiseGroup(group_inner) then " " else keep_whole_match )

    s = dropOrphanBrackets(s)
    s = collapse_runs_of_whitespace_to_single_space(s)
    s = trim_whitespace(s)
    s = strip_leading_chars(s,  any of: whitespace . _ - – )
    s = strip_trailing_chars(s, any of: whitespace . _ - – )
    return s
```

Key points:

- The bracket pattern's **inner part cannot contain any bracket**, so the pass naturally matches **innermost** groups first. A nested case such as `(Saga (1968-1996)` first matches `(1968-1996)`, replaces it with a space, and leaves the now-orphan `(` to be removed by `dropOrphanBrackets`.
- The pass is a **single** left-to-right scan: text produced by a replacement is not rescanned.
- A noise group is replaced by a **single space** (not by nothing), so the words on either side do not run together.
- The final strip removes any of: whitespace, `.`, `_`, `-`, en dash `–`.

**Worked examples** (from the agreed acceptance expectations):

| Input | Result |
|---|---|
| `(Saga (1968-1996)` | `Saga` |
| `Solo Leveling (2021) (Digital) (LuCaZ)` | `Solo Leveling` |
| `(Dungeon Crawler Carl` | `Dungeon Crawler Carl` |
| `The Ultimate Hitchhiker's Guide to the Galaxy (2005)` | `The Ultimate Hitchhiker's Guide to the Galaxy` |
| `Saga 001 (2020) (Digital) (Zone-Empire)` | `Saga 001` |
| `Already Clean` | `Already Clean` |

### 1.5 `volumeInSeries(series)` (`N5`)

**Statement.** If a series name already ends by naming a volume (`Iron Man v1`, `Saga Vol. 2`, `Berserk volume 3`), return that volume number; otherwise return *absent*.

**Algorithm.**

```
function volumeInSeries(series):
    s = cleanName(series)
    m = search( s, r"(?:^|\s)(?:v|vol\.?|volume)\s*0*([0-9]+)\s*$", ignore_case )
    if m is absent: return absent
    return integer(m.group(1))
```

- Anchored at the **end** of the cleaned series.
- The marker is `v`, `vol`, `vol.` or `volume`, preceded by start-of-string or whitespace.
- Leading zeros are allowed and ignored.

**Worked examples.**

| `series` | Result |
|---|---|
| `Iron Man v1` | `1` |
| `Saga Vol. 2` | `2` |
| `Berserk volume 03` | `3` |
| `Saga` | absent |
| `V for Vendetta` | absent |

### 1.6 `dedupeSeriesVolume(name, series, volume)` (`N6`)

**Statement.** Drop a volume token from a file name when the series already carries that same volume, so a reviewer filing `Iron Man v1 01.cbr` under series `Iron Man v1` does not get `Iron Man v1 v01 #001.cbz`. Only the token **right after the series prefix** is removed.

**Algorithm.**

```
function dedupeSeriesVolume(name, series, volume):
    vol = trim(volume or "")
    s   = cleanName(series)
    if vol == "" or s == "": return name
    if volumeInSeries(s) != integer(vol): return name

    esc = regex_escape(s)
    pattern = r"^" + esc + r"\s+v0*" + str(integer(vol)) + r"(?=\s|$)"
    return replace_first( name, pattern, replacement = s, ignore_case )
```

- The match is anchored at the start of `name`.
- The volume token is written as `v` followed by optional zeros followed by the **integer** value of `volume` (so `"05"` becomes `5`).
- It is replaced by the cleaned series `s`, so any `Vol.`/`v` styling normalises to the series spelling.
- The lookahead `(?=\s|$)` ensures the token is followed by whitespace or end-of-string (it does not eat the following number).

**Worked example.** `name = "Iron Man v1 01"`, `series = "Iron Man v1"`, `volume = "1"` → `volumeInSeries("Iron Man v1") == 1 == integer("1")` → match `^Iron Man v1\s+v0*1` → replace with `Iron Man v1` → **`Iron Man v1 01`**. (The `v1` token was part of the matched prefix and is re-emitted as the series spelling, so the file name no longer repeats the volume before the issue number.)

### 1.7 `cleanBookTitle(title, series)` (`N7`)

**Statement.** A book title with a repeated series prefix and/or a trailing series blurb removed:
`"Dungeon Crawler Carl: A LitRPG/Gamelit Adventure"` → `"A LitRPG/Gamelit Adventure"`;
`"The Gate of the Feral Gods: Dungeon Crawler Carl Book 4"` → `"The Gate of the Feral Gods"`.
A title with no series (or no match) is only `cleanName`-ed, so `"Dune: Messiah"` is left alone.

**Algorithm.**

```
function cleanBookTitle(title, series = ""):
    cleaned = cleanName(title)
    name    = cleanName(series)
    if cleaned == "" or name == "": return cleaned

    esc = regex_escape(name)

    out = cleaned
    # 1. leading "<Series>: " / "<Series> - " / "<Series> – "
    out = replace_first( out, r"^" + esc + r"\s*[:\-–]\s*", "", ignore_case )
    # 2. trailing ": <… series …>" blurb (a segment after a separator that mentions the series)
    out = replace_first( out, r"\s*[:\-–]\s*[^:]*\b" + esc + r"\b[^:]*$", "", ignore_case )
    # 3. trailing ": Book 4" / ": Vol. 2" / ": Part 01" / ": #3" (and anything after)
    out = replace_first( out, r"\s*[:\-–]\s*(?:book|vol\.?|volume|part|#)\s*[0-9]+\b.*$", "", ignore_case )
    out = trim(out)
    return out if out != "" else cleaned
```

- Separators are colon `:`, hyphen `-`, en dash `–`.
- `esc` is the series name with regular-expression metacharacters escaped (`\ . * + ? ( ) [ ] { } | ^ $`).
- The word-boundary `\b` around the series name means "the series name as a whole word/phrase".
  > **Trap.** `\b` is defined in terms of ASCII word characters (`[A-Za-z0-9_]`). Keep that definition. If the series name begins or ends with a non-word character the boundary behaves accordingly; use the corpus for exact cases.

**Worked examples.**

| title | series | Result |
|---|---|---|
| `Dungeon Crawler Carl: A LitRPG/Gamelit Adventure` | `Dungeon Crawler Carl` | `A LitRPG/Gamelit Adventure` |
| `The Gate of the Feral Gods: Dungeon Crawler Carl Book 4` | `Dungeon Crawler Carl` | `The Gate of the Feral Gods` |
| `Dune: Messiah` | *(none)* | `Dune: Messiah` |
| `The Ultimate Hitchhiker's Guide to the Galaxy (2005)` | `(Dungeon Crawler Carl` | `The Ultimate Hitchhiker's Guide to the Galaxy` |

---

## 2. Book identification and canonical names (rule family `I`)

These rules derive a book's identity from its filename, layer it under embedded metadata, and produce the canonical library name.

### 2.1 `baseOf(filename)` (`I1`)

**Statement.** The filename without its extension, trimmed.

```
function baseOf(filename):
    dot = last_index_of(filename, ".")
    base = filename if dot <= 0 else filename[0:dot]
    return trim(base)
```

A leading dot does not count as an extension separator (`dot <= 0`), so `.hidden` is returned whole. `archive.tar.gz` → `archive.tar`.

### 2.2 `normaliseNumber(value)` (`I2`)

**Statement.** A leading zero pad goes; a decimal stays: `"01"` → `"1"`, `"1.5"` → `"1.5"`, `"007"` → `"7"`.

```
function normaliseNumber(value):
    n = parse_as_number(value)          # see trap
    if n is a finite number:
        return shortest_canonical_decimal(n)   # integer if whole, else decimal, no trailing zeros
    return value
```

> **Trap.** JavaScript's `Number(value)` accepts leading/trailing whitespace, hexadecimal (`0x10`), exponent forms (`1e3`) and the empty string (`Number("") == 0`). Python's `int`/`float` do not.
> **Intended:** the inputs to this rule are decimal numbers with an optional fractional part (as produced by the patterns in `I3`/`I4`). Parse as a decimal number; strip leading zeros from the integer part and trailing zeros from the fractional part; render integers without a fractional part. If the string is not a valid decimal number, return it unchanged. `"1.50"` → `"1.5"`; `"1.0"` → `"1"`.

### 2.3 `stripSeriesMarker(name)` (`I3`)

**Statement.** Strip a trailing `(series #n)` / `[series #n]` marker, keeping its number.

```
function stripSeriesMarker(name):
    m = search( name, r"\s*[(\[]( [^)\]]* # \s* ([0-9]{1,4}(?:\.[0-9]+)?) ) \s*[)\]]\s*$" )
    if m is absent: return { name: name }
    return {
        name:   trim( name[0 : m.start] ),
        number: normaliseNumber(m.group(2)),
    }
```

- The group must contain a `#`, then optional whitespace, then 1–4 ASCII digits with an optional decimal fraction.
- The group may contain other text before the `#`.
- The group is anchored at the end of the string, with optional surrounding whitespace.

**Worked example.** `"Mistborn 01 - The Final Empire (Mistborn #1)"` → `{ name: "Mistborn 01 - The Final Empire", number: "1" }`.

### 2.4 `guessFromFilename(filename)` (`I4`)

**Statement.** Best-effort title/series/number/author from a book filename. The separator is a **spaced dash** `" - "`, so a hyphen inside a word (`Catch-22`) never splits and a numeric title (`1984`) stays a title. Recognises, in order:

1. `Series 01 - Title`
2. `Series #1`
3. `01 - Title`
4. `Author - Title`
otherwise the whole base is the title.

**Algorithm.** (Apply in this exact order; return on first match.)

```
function guessFromFilename(filename):
    marker = stripSeriesMarker( baseOf(filename) )
    base   = marker.name
    if base == "": return { number: marker.number }

    # 1. "Series <num> - <Title>"
    m = match( base, r"^(.+?)\s+([0-9]{1,4}(?:\.[0-9]+)?)\s+-\s+(.+)$" )
    if m: return { series: trim(m.1), number: normaliseNumber(m.2), title: trim(m.3) }

    # 2. "Series #<num>"
    m = match( base, r"^(.+?)\s+#\s*([0-9]{1,4}(?:\.[0-9]+)?)$" )
    if m: return { series: trim(m.1), number: normaliseNumber(m.2) }

    # 3. "<num> - <Title>"
    m = match( base, r"^([0-9]{1,4}(?:\.[0-9]+)?)\s+-\s+(.+)$" )
    if m: return { number: normaliseNumber(m.1), title: trim(m.2) }

    # 4. "Author - <rest>"   (author part must contain no digit)
    m = match( base, r"^([^0-9]+?)\s+-\s+(.+)$" )
    if m:
        inner = guessFromFilename( trim(m.2) )      # recurse
        return {
            author: trim(m.1),
            title:  inner.title if inner.title exists else (absent if inner.series exists else trim(m.2)),
            series: inner.series,
            number: inner.number if inner.number exists else marker.number,
        }

    return { title: base, number: marker.number }
```

- `.+?` is non-greedy; `(?:...)?` is optional; `\s+` requires at least one whitespace.
- Numbers are `[0-9]{1,4}` with an optional `.[0-9]+` fraction.

**Worked examples.**

| filename | Result |
|---|---|
| `Dune.epub` | title `Dune` |
| `Mistborn 01 - The Final Empire.epub` | series `Mistborn`, number `1`, title `The Final Empire` |
| `Brandon Sanderson - The Final Empire.epub` | author `Brandon Sanderson`, title `The Final Empire`, no series |
| `Catch-22.epub` | title `Catch-22` |
| `1984.epub` | title `1984` |

### 2.5 `bookMediaDefaults(embedded, filename)` (`I5`)

**Statement.** The review-card defaults for a book: **embedded metadata wins; the filename guess fills the gaps.** `Title` is always non-empty (the search key); `Series`/`Number` stay absent for a standalone book rather than being invented from the filename.

**Algorithm.**

```
function bookMediaDefaults(embedded, filename):
    guess = guessFromFilename(filename)
    out   = copy(embedded)

    if trim(out.Title) == "":  out.Title = trim(guess.title) or baseOf(filename) or "Unsorted"

    if trim(out.Series) == "":
        if trim(guess.series) != "": out.Series = trim(guess.series)
        else:                        remove out.Series

    if trim(out.Number) == "":
        if trim(guess.number) != "": out.Number = trim(guess.number)
        else:                        remove out.Number

    # "Author - Title" filename gives an author even when the file carries no Writer
    if trim(out.Writer) == "" and trim(guess.author) != "":
        out.Writer = trim(guess.author)

    # clean what the card will show
    if trim(out.Series) != "": out.Series = cleanName(out.Series)
    else:                      remove out.Series

    # author-as-series guard: an author written as the series is not a series
    if out.Series exists and out.Writer exists
       and lower(trim(out.Series)) == lower(trim(out.Writer)):
        remove out.Series

    if trim(out.Title) != "": out.Title = cleanBookTitle(out.Title, out.Series or "")
    else:                     remove out.Title

    return out
```

- "embedded wins" means an existing non-blank embedded value is never overwritten by the filename.
- The author-as-series guard prevents a common ebook-tool mistake from turning a standalone book back into `<Author> - <Title>` on re-upload.

**Worked examples.**

| embedded | filename | Result |
|---|---|---|
| *(none)* | `Mistborn 01 - The Final Empire.epub` | Series `Mistborn`, Number `1`, Title `The Final Empire` |
| *(none)* | `Brandon Sanderson - The Final Empire.epub` | Title `The Final Empire`, Writer `Brandon Sanderson`, no Series |
| `Title=Dune, Series=Dune, Number=1` | `Frank Herbert - Dune.epub` | Series `Dune`, Title `Dune`, Number `1` (embedded wins) |
| `Title=The Ultimate Hitchhiker's Guide to the Galaxy, Writer=Douglas Adams, Series=Douglas Adams` | `AuthorSeries.epub` | Series removed (author-as-series), Title kept |
| `Title=The Gate of the Feral Gods: Dungeon Crawler Carl Book 4, Series=Dungeon Crawler Carl, Number=4` | `Blurb.epub` | Title `The Gate of the Feral Gods`, Series `Dungeon Crawler Carl`, Number `4` |

### 2.6 `canonicalBookName(meta)` (`I6`)

**Statement.** The **one** canonical naming rule for books, so the review card and the approval plan cannot disagree. Returns the folder name and the file name (without extension). Both parts are returned **unsanitised**; callers run each part through `safeSegment` ([§3.1](#31-safesegment-p1)) before touching the filesystem.

**Algorithm.**

```
function canonicalBookName(meta):
    series = cleanName( trim(meta.Series or "") )
    number = trim(meta.Number or "")
    author = cleanName( trim(meta.Writer or "") )
    title  = cleanBookTitle( trim(meta.Title or ""), series )

    if series != "":
        suffix = (" #" + number) if number != "" else ""
        filename = (series + suffix + " - " + title) if title != ""
                   else (series + suffix)
        return { series: series, filename: filename }        # folder = the series

    # standalone: folder = author, else title, else "Unsorted"; file = title, else "Untitled"
    return { series: author or title or "Unsorted", filename: title or "Untitled" }
```

**Canonical shapes.**

- **Series book, series folder:** folder `<Series>`; file **`<Series> #<n> - <Title>`** (drop ` #<n>` if there is no number; drop ` - <Title>` if there is no title).
- **Standalone book, author folder:** folder `<Author>` (or `<Title>` if there is no author, or `Unsorted`); file **`<Title>`** (or `Untitled`).

**Worked examples.**

| meta | folder (`series`) | file (`filename`) |
|---|---|---|
| Series `Dungeon Crawler Carl`, Number `4`, Title `The Gate of the Feral Gods` | `Dungeon Crawler Carl` | `Dungeon Crawler Carl #4 - The Gate of the Feral Gods` |
| Series `Mistborn`, Number `1`, Title `The Final Empire` | `Mistborn` | `Mistborn #1 - The Final Empire` |
| no Series, Writer `Douglas Adams`, Title `The Ultimate Hitchhiker's Guide to the Galaxy` | `Douglas Adams` | `The Ultimate Hitchhiker's Guide to the Galaxy` |
| no Series, no Writer, Title `Dune` | `Dune` | `Dune` |
| Series `Saga`, no Number, no Title | `Saga` | `Saga` |

### 2.7 Manga and comic filename shapes (suggested templates) (`I7`)

**Statement.** For manga and comic libraries, the **default** file-name shape offered to the reviewer is:

- **Manga:** `<Series>[ v<VV>][ c<NNN>]`
- **Comic:** `<Series>[ v<VV>][ #<NNN>]`

where `VV` is the volume zero-padded to **2** digits, `NNN` is the issue number zero-padded to **3** digits, and the optional parts are omitted when their value is absent. The volume token is omitted when the series already names that volume ([§1.5](#15-volumeinseries-n5)).

**Intended status.** These are **suggested** templates for the review UI. Unlike the book rule (`I6`, which is authoritative for the file name on approval), the approval pipeline for manga/comics takes the reviewer's **edited** filename, runs it through `cleanName` (`N4`) and `dedupeSeriesVolume` (`N6`) against the resolved series, and appends the target extension. Implement the templates as the default suggestion, and `cleanName` + `dedupeSeriesVolume` as the authoritative transform of whatever name is submitted.

**Worked examples.**

| media | Series / Volume / Number | Suggested name |
|---|---|---|
| Manga | `Solo Leveling`, no volume, `159` | `Solo Leveling c159` |
| Manga | `Berserk`, `3`, `7` | `Berserk v03 c007` |
| Comic | `Saga`, `1`, `5` | `Saga v01 #005` |
| Comic | `Iron Man v1`, `1`, `1` | `Iron Man v1 #001` (volume token suppressed) |

---

## 3. Filesystem-safe segments (rule family `P`)

### 3.1 `safeSegment(input)` (`P1`)

**Statement.** Turn an arbitrary string into one filesystem-safe **path segment** (a folder name or a file name): no separators, no control or Windows-reserved characters, no leading dots/spaces, no trailing dots/spaces, and **no more than 200 UTF-8 bytes**. Return *absent* if nothing usable is left.

**Algorithm.**

```
function safeSegment(input):
    s = NFC(input)
    # replace control chars and Windows-reserved characters with a space
    s = replace_all( s, r"[\u0000-\u001F\u007F<>:\"/\\|?*]", " " )
    s = collapse_runs_of_whitespace_to_single_space(s)
    s = strip_leading_chars(s,  any of: "." or " ")
    s = strip_trailing_chars(s, any of: "." or " ")
    while utf8_byte_length(s) > 200:
        s = remove_last_code_point(s)          # whole code point, never a partial one
    if s == "" or s == "." or s == "..": return absent
    return s
```

**The 200-byte cap is in BYTES, not code points.** This is the single most important property of this rule and the most likely port bug.

> **Trap (bytes vs code points).** A naive port that limits the string to 200 *characters* is wrong. The cap is on the length of the string's **UTF-8 encoding**.
> **Trap (astral characters).** The reference removes one UTF-16 code unit at a time while trimming to the cap, which can split a surrogate pair and leave an invalid character. **Intended:** remove one whole **Unicode code point** per iteration.

**Multi-byte worked example.**

- `é` is **2 bytes** in UTF-8. 100 × `é` = 200 bytes → **kept in full**. 101 × `é` = 202 bytes → trimmed to 100 × `é` = 200 bytes.
- A CJK character (e.g. `字`) is **3 bytes**. 67 × `字` = 201 bytes → trimmed to 66 × `字` = **198 bytes** (the 67th code point is removed whole).
- `Saga: Volume 1?` → reserved characters `:` and `?` become spaces → `Saga  Volume 1 ` → collapse → `Saga Volume 1` → **`Saga Volume 1`**.
- `../../etc/passwd` → `/` becomes spaces, leading dots stripped → `etc passwd` (no traversal).

### 3.2 `splitName(filename)` (`P2`)

**Statement.** Split a filename into its base and its lower-cased extension.

```
function splitName(filename):
    dot = last_index_of(filename, ".")
    if dot <= 0: return { base: filename, ext: "" }
    return { base: filename[0:dot], ext: lower(filename[dot+1:]) }
```

A leading dot is not an extension separator (`dot <= 0`).

**Worked example.** `"Saga #005.CBZ"` → `{ base: "Saga #005", ext: "cbz" }`. `".bashrc"` → `{ base: ".bashrc", ext: "" }`.

### 3.3 `targetExtension(kind)` (`P3`)

**Statement.** The extension an approved file of a given file kind is saved with. Comic archives always become **CBZ**.

```
function targetExtension(kind):
    if kind == "comic": return "cbz"
    return kind            # "epub" -> "epub"; "pdf" -> "pdf"
```

File kinds are defined in [§8.2](#82-file-kind-mapping).

### 3.4 Natural order (`P4`)

**Statement.** Order page images and series lists the way a person expects, so `page 2` comes before `page 10`. This is "natural sort": embedded runs of digits are compared as **numbers**, and the comparison is **case-insensitive and accent-insensitive**.

> **Trap.** The reference uses `localeCompare(a, b, {numeric: true, sensitivity: "base"})`. Python has **no exact equivalent**. A plain `str` sort gives `page 10` before `page 2`; a plain `int` conversion is wrong for mixed names.
> **Intended:** implement the algorithm below. It must not depend on the runtime's locale.

**Algorithm.**

```
function natural_compare(a, b):
    ia = 0; ib = 0
    while ia < len(a) and ib < len(b):
        ca = a[ia]; cb = b[ib]
        if ca is an ASCII digit and cb is an ASCII digit:
            ra = read_full_ascii_digit_run(a, ia); na = integer(ra); ia += len(ra)
            rb = read_full_ascii_digit_run(b, ib); nb = integer(rb); ib += len(rb)
            if na != nb: return -1 if na < nb else +1
            # equal numeric value: more leading zeros sorts first (deterministic tie-break)
            if len(ra) != len(rb): return -1 if len(ra) < len(rb) else +1
        else:
            fa = fold_for_base(ca)     # strip diacritics + casefold
            fb = fold_for_base(cb)
            if fa != fb: return -1 if fa < fb else +1
            ia += 1; ib += 1
    if (len(a) - ia) != (len(b) - ib):
        return -1 if (len(a) - ia) < (len(b) - ib) else +1
    return 0
```

- `fold_for_base` = decompose to NFD, remove combining marks, then casefold. This gives the `sensitivity:"base"` behaviour (case- and accent-insensitive).
- Runs of ASCII digits are read in full and compared by value; ties by digit-run length for determinism.

**Worked examples.** `p001.jpg < p002.jpg < p010.jpg`; `Solo Leveling 2 < Solo Leveling 10`; `Émile < emile` compares equal at the letter level (accent-insensitive).

---

## 4. Embedded metadata (rule family `M`)

This section defines the **field set**, the **age-rating vocabulary**, the **read/write mapping** for the two supported embedded formats, and the **single validation rule**. Both formats are exposed with the **same field names** so the rest of the system treats them alike.

### 4.1 The field set (`M1`)

The editable fields, in the canonical order of the comic-metadata schema (this order is also the iteration order for merging, [§6](#6-provider-record-merge)):

```
1  Title        9  Writer         17 Publisher
2  Series      10  Penciller      18 Imprint
3  Number      11  Inker          19 Genre
4  Count       12  Colorist       20 Tags
5  Volume      13  Letterer       21 Web
6  Summary     14  CoverArtist    22 PageCount
7  Year        15  Editor         23 LanguageISO
8  Month       16  ...            24 AgeRating
```

Precisely, the 24 fields are:

`Title, Series, Number, Count, Volume, Summary, Year, Month, Day, Writer, Penciller, Inker, Colorist, Letterer, CoverArtist, Editor, Publisher, Imprint, Genre, Tags, Web, PageCount, LanguageISO, AgeRating`

`Count` is the total-issues count; `PageCount` is derived from the file on approval and is not user-editable (see [§4.5](#45-unified-field-validation-m7) and [§7.3](#73-approval-build)).

### 4.2 Age-rating vocabulary (`M2`)

`AgeRating` is a closed vocabulary. A value outside it is invalid. The exact, case-sensitive set (15 values):

```
Unknown, Rating Pending, Early Childhood, Everyone, G, Everyone 10+, PG,
Kids to Adults, Teen, MA15+, Mature 17+, M, R18+, Adults Only 18+, X18+
```

**Intended:** exact membership, case-sensitive.

### 4.3 ComicInfo read/write mapping (`M3`, `M4`)

**Preservation rule (applies to both formats).** Reading exposes the field set. Writing is a **read-modify-write** that changes only the named fields and **preserves everything else**: unknown elements, attributes, namespaces, child ordering, page lists and any other content not being edited.

#### 4.3.1 Read (`M3`)

```
function readComicInfo(xml):
    reject if utf8_byte_length(xml) > 2 MiB        # safety cap
    doc  = parse_xml_preserving_order(xml)
    root = first element of doc named "ComicInfo"
    out  = {}
    for child in children_of(root):
        if child.tag is one of the 24 field names:
            value = trim( concatenated_text_of(child) )
            if value != "": out[child.tag] = value
    return out
```

- Only the 24 field names are read; anything else is ignored on read (but preserved on write).
- Values are trimmed; an empty element is treated as absent.
- Numbers are read as **text** (`"026"` stays `"026"`, not `26`).

#### 4.3.2 Write (`M4`)

```
function writeComicInfo(existingXml_or_absent, updates, drop = []):
    doc = parse_preserving_order(existingXml) if existingXml else []
    root = first element named "ComicInfo", or create one with attributes
             xmlns:xsd = "http://www.w3.org/2001/XMLSchema"
             xmlns:xsi = "http://www.w3.org/2001/XMLSchema-instance"
    kids = children_of(root)

    for field in the 24 field names (canonical order):
        if field in drop:
            remove the first existing child with that tag, if any
            continue
        value = trim(updates[field])
        if value == "": continue                       # empty updates never erase
        existing = first child with that tag
        if existing:
            existing.text = value                      # position and attributes preserved
        else:
            # insert after the last KNOWN field that precedes it in canonical order
            at = 0
            for i, child in enumerate(kids):
                if child.tag is a known field and its order < order(field): at = i + 1
            insert element(field, value) at position at

    emit with XML declaration:  <?xml version="1.0" encoding="utf-8"?>\n<doc.trimmed>\n
```

- New fields are inserted **in schema order**, after the last known field that precedes them. Unknown elements are ignored when choosing the position.
- An empty/blank update is a no-op (it does not clear a value); to remove a value, name the field in `drop`.

**Worked example.** Existing ComicInfo has `Summary="keep me"`, `Publisher="Pub House"`, `Number="5"`, `PageCount="9"`. Write `{Number: "5", Year: "2001", Writer: "Jane Writer", AgeRating: "Teen", Title: "The Fifth", PageCount: "3"}` with `drop=["Volume"]`:
- `Number` keeps its position, updated to `5`; `Year`, `Writer`, `Title` inserted in schema order; `AgeRating` inserted; `PageCount` corrected to `3`; `Summary` and `Publisher` untouched; any `Volume` removed.

### 4.4 OPF (EPUB) read/write mapping (`M5`, `M6`)

The EPUB package document is an OPF file whose path is given by `META-INF/container.xml` (the `rootfile/@full-path` attribute). Field names are the **same** as [§4.1](#41-the-field-set-m1).

#### 4.4.1 Read (`M5`)

Locate the `<package>` element, then its `<metadata>` child. Map:

| OPF source | Field | Rule |
|---|---|---|
| `dc:title` | `Title` | first element, text |
| `dc:creator` | `Writer` | **all** elements, joined with `", "` |
| `dc:publisher` | `Publisher` | first element |
| `dc:description` | `Summary` | first element |
| `dc:language` | `LanguageISO` | first element |
| `dc:subject` | `Genre` | **all** elements, joined with `", "` |
| `dc:date` | `Year` | first element, **first 4 characters** |
| `<meta name="calibre:series" content="…">` | `Series` | content attribute |
| `<meta name="calibre:series_index" content="…">` | `Number` | content attribute |

Only non-empty results are kept.

#### 4.4.2 Write (`M6`)

Read-modify-write; only non-blank updates apply; everything else is preserved.

| Field | Target | Rule |
|---|---|---|
| `Title` | `dc:title` | set text of existing, else append |
| `Writer` | `dc:creator` | **list**: split the value on `,` or `;`, trim, drop empties; replace **all** existing `dc:creator` elements, inserting the new list at the position of the first existing one (or at the end if none) |
| `Publisher` | `dc:publisher` | set text of existing, else append |
| `Summary` | `dc:description` | set text of existing, else append |
| `LanguageISO` | `dc:language` | set text of existing, else append |
| `Genre` | `dc:subject` | **list**, same rule as `Writer` |
| `Year` | `dc:date` | if an existing `dc:date`'s first 4 characters already equal the new year, **keep the existing (fuller) value**; otherwise set/append the year |
| `Series` | `calibre:series` | update the existing `<meta name="calibre:series">`'s `content`, else append a new `<meta>` |
| `Number` | `calibre:series_index` | same rule as `Series` |

**Worked example.** An EPUB with `dc:title=Old Title`, `dc:creator=Old Author`, `dc:date=2001-05-03`. Write `{Title: "New Title", Writer: "Ann Lee, Bo Kim", Number: "2", Series: "Kc5 Books"}`:
- `dc:title` → `New Title`; `dc:creator` replaced by `Ann Lee` and `Bo Kim` (two elements, at the first creator's position); `dc:date` kept as `2001-05-03` if the update's `Year` is `2001`; a `calibre:series` meta and a `calibre:series_index` meta appended/updated; the `dc:identifier` untouched.

### 4.5 Unified field validation (`M7`)

**Statement.** There is **exactly one** validation rule for an editable field value. It returns either an accepted, normalised value or a **rejection**. A rejected value is never written and is never silently coerced. How a rejection is surfaced is the **caller's** decision.

**Algorithm.**

```
FIELD_LIMITS = { Summary: 20000, Web: 2000 }      # every other field: 500
DERIVED      = { PageCount }                       # never user-supplied; taken from the file

function validateField(field, raw):
    if field in DERIVED: return reject("derived field")
    if raw is not a string: return reject("not a string")
    text = trim( remove_all( raw, NUL ) )          # strip NUL characters
    if text == "": return reject("empty")
    if length(text) > (FIELD_LIMITS[field] or 500): return reject("too long")

    if field == "Year"  and not matches(text, r"^[0-9]{4}$"):        return reject("year")
    if field in {"Month","Day"} and not matches(text, r"^[0-9]{1,2}$"): return reject("month/day")
    if field == "AgeRating" and text not in AGE_RATINGS:            return reject("age rating")
    if field == "LanguageISO" and not matches(text, r"^[a-z]{2}(-[a-z]{2})?$", ignore_case):
        return reject("language")

    return accept(text)
```

**Caller policy (deliberately not part of the shared rule):**

- **Human-entered values** (the review/approval form): a rejection is **surfaced as an error naming the field**, and the operation does not proceed. Rationale: the reviewer is present and can fix it; failing loudly prevents an invalid value from reaching a library file.
- **Provider-supplied values** (external metadata merge, [§6](#6-provider-record-merge)): a rejection means the field is **omitted from the proposal**. Rationale: the reviewer must not be blocked by a third party's bad data, and the field simply falls through to the next provider.

**Why this resolution (D2).** The two reference validators disagreed on *which* fields they checked (`LanguageISO` was checked in one and not the other) and on *how* a violation was handled (throw vs silent drop). This specification removes both divergences: one predicate, one limit table, one vocabulary. The validator's contract is **explicit rejection** rather than silent coercion, because a silently dropped over-limit value is indistinguishable from a value that was never supplied, which is exactly the class of bug that produced the divergence. The *surface-vs-skip* choice stays with the caller because the two call sites have genuinely different needs, and that difference is not a rule about what counts as valid.

**Worked examples.**

| field | raw | Result |
|---|---|---|
| `Year` | `"19x"` | reject (`year`) |
| `Year` | `"1968"` | accept `1968` |
| `AgeRating` | `"Bogus"` | reject (`age rating`) |
| `AgeRating` | `"Teen"` | accept `Teen` |
| `Summary` | 20 001 chars | reject (`too long`) |
| `LanguageISO` | `"en-GB"` | accept `en-GB` |
| `LanguageISO` | `"english"` | reject (`language`) |
| `PageCount` | `"3"` | reject (`derived field`) |

---

## 5. Review / approve / reject / fix state machine (`S1`, `S2`)

### 5.1 Upload statuses (`S1`)

An upload row has exactly one **status**. The durable statuses are:

| Status | Meaning |
|---|---|
| `uploading` | bytes are still arriving |
| `checking` | upload complete; content sniff, hash and duplicate check running |
| `pending` | accepted; waiting for a reviewer |
| `approving` | a reviewer approved it; the background placement job is running (transient) |
| `approved` | the file has been placed in the library |
| `fixing` | an approved file is being re-filed/corrected (transient) |
| `rejected` | a reviewer rejected it; the file is kept for a retention period and can be restored |
| `invalid` | content did not match the declared extension, or could not be processed |
| `duplicate` | the content already exists in the queue or the library |
| `cancelled` | the uploader cancelled an in-progress upload |
| `expired` | an abandoned partial upload was purged |
| `withdrawn` | the uploader withdrew a file that was waiting for review |

`approving` and `fixing` are **transient**: they exist only while a background job runs. A durable design may model them as a `Job` row rather than a status value; what matters is that an interrupted `approving`/`fixing` item is recoverable (see [§5.3](#53-resume-and-concurrency)).

### 5.2 Transitions

```
upload created                         -> uploading
upload finished                        -> checking
  content sniff ok, hash ok            -> pending
  content mismatch / unreadable        -> invalid
  duplicate found                      -> duplicate
uploader withdraw (uploading)          -> cancelled
uploader withdraw (pending)            -> withdrawn
abandoned partial (no bytes for a while) -> expired

reviewer approves (pending)            -> approving      (compare-and-swap)
  job success                          -> approved
  job failure                          -> pending        (with a review error)

reviewer rejects (pending)             -> rejected       (via a transient claim value)
  retention elapsed                    -> rejected       (file deleted; row kept)

reviewer fixes (approved)              -> fixing         (compare-and-swap)
  job success                          -> approved
  job failure                          -> approved       (with a review error)

restore (rejected, file still present) -> pending
```

Rules:

- **Approve/reject/fix claims are compare-and-swap.** The transition is applied only if the row is still in the expected source status; if zero rows change, the caller is told the item is already being handled. This makes two concurrent reviewers safe.
- **Rejection requires a reason.** The reason is stored and shown to the uploader.
- **Rejected files are retained** for a configured number of days, then the bytes are deleted while the row and reason remain. A rejected upload whose file is still present can be **restored** to `pending`.
- **One placement job runs at a time** (placement is disk- and CPU-heavy). Jobs are queued by id, and duplicates in the queue are collapsed.

### 5.3 Resume and concurrency

- The **approval plan** (everything the job needs: target library, series folder, destination path, resolved metadata) is persisted **before** the status is flipped to `approving`/`fixing`, so a restart can rebuild the job.
- On start-up, any row in `approving`/`fixing` with a persisted plan is re-queued; a row without a plan is failed back to `pending` (approve) or left `approved` with a review error (fix).
- The destination is re-checked immediately before the atomic rename (a time-of-check/time-of-use guard, [§5.4](#54-placement)).

### 5.4 Placement (`S2`)

**Statement (the safety rule).** Build the replacement **beside the destination** under a temporary name that a scanner ignores; **never modify or remove the source until the replacement is in place**; then rescan **both** locations.

```
function place(job):
    source     = pending file (approve) OR library file (fix)
    destination = series folder + final file name
    temporary  = series_folder + "." + marker + job_id + ".part"   # beside destination

    # 1. TOCTOU guard: refuse to clobber anything but a fix's own file
    if exists(destination) and not (mode == fix and destination == source):
        fail("destination already exists")

    mkdir(series_folder)
    # 2. build beside the destination
    #    - approve: the source may be consumed (moved) at the end
    #    - fix:     the source is NEVER moved or changed here (copy/extract only)
    build(source -> temporary, keep_source = (mode == fix))
    final_hash = sha256(temporary)
    # 3. replacement is now complete and beside the destination
    rename(temporary, destination)          # atomic; replaces the old file when a fix keeps the name

    # 4. only now touch the source
    if mode == approve: remove(source); remove(cover)
    if mode == fix and destination != source: remove(source); remove_dir_if_empty(parent(source))

    # 5. rescan BOTH locations
    if mode == fix and parent(source) != series_folder:
        if exists(parent(source)): rescan(parent(source)) else: rescan_whole_library()
    rescan(series_folder)
```

Properties that must hold:

- The temporary name begins with a dot-prefixed marker and ends in `.part`, so a scanner that ignores hidden/dot files will not pick up a half-written file.
- In **fix** mode, the source is copied (or extracted read-only) to build the output; it is removed only **after** the rename. A failure at any point leaves the library file exactly as it was, and the temporary is removed.
- In **approve** mode, the source is the staged upload; it is removed only after the rename.
- **Both** the old location and the new location are rescanned. If the old folder no longer exists, the whole library is rescanned so the old series is dropped.
- On failure, the item returns to a reviewable state with a **review error**; the library is unchanged.

**Worked example (fix).** An approved `Saga #005.cbz` is filed under the wrong series folder `Saga (old)`. A reviewer fixes it to folder `Saga` with the same filename.
1. Destination exists? Yes, but it is the source's own path only if unchanged — here the folder differs, so `destination != source` and the destination is new.
2. Build `Saga/.kc-<id>.part` from `Saga (old)/Saga #005.cbz` (source untouched).
3. Rename `.kc-<id>.part` → `Saga/Saga #005.cbz`.
4. Remove `Saga (old)/Saga #005.cbz`; remove `Saga (old)` if now empty.
5. Rescan `Saga (old)` (or the whole library if it is gone) and rescan `Saga`.

### 5.5 Post-placement verification (integration-flavoured)

After a successful placement, the item may enter a verification sub-state: the placement is recorded as *placed*, then confirmed once the consuming server reports the exact file, or flagged as *missing* after a timeout (with an intermediate "ask for another scan" step). This is a Kavita-integration concern; it is described here only so the state machine's shape is complete. A reimplementation that owns its own scanner may replace it with a direct "the file is on disk and indexed" check.

---

## 6. Provider record merge (`G1`)

`mergeRecords` folds one or more external provider records into the field set, honouring precedence, locks and conflicts.

### 6.1 Inputs

```
records : ordered list of provider records, each with { provider, fields }
          (highest precedence first; or unordered when `order` is supplied)
current : values already present in the form/file
order   : ordered list of provider ids; records are re-sorted to match
force   : fields the caller explicitly allows to overwrite
locked  : fields the caller has locked; they are never proposed
```

### 6.2 Algorithm

```
function mergeRecords(records, current = {}, order = absent, force = [], locked = []):
    # 1. re-sort by provider precedence if `order` is given
    if order is present:
        index = map(provider_id -> position in order)
        records = stable_sort(records,
                    key = index[record.provider] if present else +infinity)
        # unlisted providers keep their relative order, after all listed ones

    forceSet  = set(force)
    lockedSet = set(locked)

    fields = {}; provenance = {}; conflicts = []; seen = set()

    # 2. walk records in precedence order
    for record in records:
        for field in FIELD_SET in canonical order:            # §4.1
            if field in seen or field in lockedSet: continue
            value = validateField(field, record.fields[field])   # §4.5
            if value is a rejection: continue                    # do NOT mark seen
            seen.add(field)                                      # first valid value wins the field
            existing = trim(current[field] or "")
            if existing != "" and field not in forceSet:
                conflicts.append({ field, current: existing, proposed: value, source: record.provider })
                continue                                         # not applied; no later record may fill it either
            fields[field] = value
            provenance[field] = record.provider

    return { fields, provenance, conflicts }
```

### 6.3 Semantics

- **Fill vs overwrite.** A non-empty `current` value is **kept** unless the field is in `force`. This is the "never overwrite what the file already has unless the caller asks" rule.
- **First valid value wins.** The first record (in precedence order) to supply a **valid** value for a field claims that field (`seen`). Invalid values are skipped and do **not** claim the field, so a lower-precedence record may still supply it.
- **Lock.** A locked field is never proposed and never produces a conflict.
- **Force.** A forced field overwrites a non-empty current value instead of being reported as a conflict.
- **Conflict.** When a provider would replace a non-empty, non-forced current value, the value is **not** applied; it is reported in `conflicts` with the current value, the proposed value and the source, so a reviewer can accept it explicitly. The field is marked seen, so no lower-precedence record is consulted either.
- **Provenance.** For every applied field, the source provider id is recorded.
- **Validation.** Provider values pass through the single validator ([§4.5](#45-unified-field-validation-m7)); the `current` values are taken as already valid.

> **Trap (stable sort).** When `order` is supplied, the sort must be **stable**: records whose provider is not in `order` keep their original relative order and sort after all listed providers. Use a stable sort keyed on the order index (unlisted → a value larger than any index).

**Worked example.** `current = { Series: "Saga", Year: "2020" }`, `force = []`, two records in precedence order: A `{ Series: "Saga (Image)", Number: "5" }`, B `{ Year: "2019", Publisher: "Image" }`.
- `Series`: A supplies a valid value; current is non-empty and not forced → **conflict** `{current: "Saga", proposed: "Saga (Image)", source: A}`; `Series` marked seen.
- `Number`: A supplies `5`; current empty → applied, provenance A.
- `Year`: B supplies `2019`; current `2020` non-empty, not forced → **conflict** `{current: "2020", proposed: "2019", source: B}`.
- `Publisher`: B supplies `Image`; current empty → applied, provenance B.
- Result: `fields = { Number: "5", Publisher: "Image" }`, `conflicts` has `Series` and `Year`.

With `force = ["Series"]`: `Series` becomes `fields.Series = "Saga (Image)"` (provenance A), and the `Series` conflict disappears.

---

## 7. Duplicate guard (`D1`)

**Statement.** A newly completed upload is a duplicate if its **content hash** matches either the **source hash** of an existing upload or the **post-repack hash** of an approved one. An approved row counts only while its file still exists on disk.

### 7.1 Algorithm

```
function isDuplicate(new_id, new_sha256):
    candidates = query uploads where
        (sha256 == new_sha256 OR final_sha256 == new_sha256)
        and id != new_id
        and status in { pending, approving, approved }
        order by created_at ascending

    for c in candidates:
        if c.status != "approved":                 return c    # queued/being-handled: counts
        if c.final_path exists on disk:            return c    # approved and present: counts
        # approved but its file is gone -> not a duplicate; keep looking
    return absent
```

### 7.2 Semantics

- **Two hashes.** Each upload stores the SHA-256 of the bytes it received (`sha256`). Each approved file additionally stores the SHA-256 of the file **as placed** (`final_sha256`), which may differ because a comic archive is repacked and an EPUB is repacked. A new upload matches on **either**: `sha256 == new` OR `final_sha256 == new`.
- **Which rows count.** Only rows in `pending`, `approving` or `approved`. Terminal rows (`invalid`, `duplicate`, `cancelled`, `expired`, `withdrawn`, `rejected`) never count.
- **The live-file re-check.** An `approved` row counts only while its placed file still exists; if the file was deleted from the library, the row is skipped and the new upload is not rejected as a duplicate of it.
- **Outcome.** A match discards the new file, sets its status to `duplicate`, and notifies the uploader with the earlier upload's filename/date and whether it is "already in the library" (`approved`) or "already waiting for review" (`pending`/`approving`).
- **Scope.** This guard sees only files the companion itself handled (rows in its upload table). It is **not** a scan of the whole library. A reimplementation that wants library-wide duplicate detection must hash all library files, including ones it did not place.

> **Trap.** Hashing only the original upload (and not the repacked file) makes the two systems disagree: a file placed by repacking has a different byte hash from its source, so a re-upload of the source would not match unless the post-repack hash is also stored and compared. Store and compare **both**.

**Worked example.** Upload X (`sha256 = aaa`) is approved and repacked, so its placed file has `final_sha256 = bbb`. Later upload Y hashes to `bbb` (the same content as X's placed file, perhaps a different source archive). Y matches X on `final_sha256` → Y is a duplicate. Later, X's placed file is deleted from the library; upload Z hashes to `bbb` again — X's row is skipped (file gone), so Z is accepted.

---

## 8. Media-type mapping

### 8.1 Library type → media class (`T1`)

**Statement (D1).** Define the mapping **once**, as a total function, and derive every downstream behaviour from the resulting **media class**. Do not duplicate library-type literals.

**Media classes:** `manga`, `comic`, `book`.

**Algorithm.**

```
function mediaClass(libraryType):
    if libraryType == 0: return "manga"
    if libraryType == 2: return "book"        # Books
    if libraryType == 4: return "book"        # Light novel
    return "comic"                            # includes 1/5/unknown; the safe default
```

**Observed integer interop.** When integrating with a server that exposes numeric library types, the observed codes are:

| Code | Meaning | Media class |
|---|---|---|
| `0` | Manga | `manga` |
| `1` | Comic (not branched on; falls through) | `comic` |
| `2` | Book | `book` |
| `3` | Images (not branched on; falls through) | `comic` |
| `4` | Light novel | `book` |
| `5` | Comics (noted as comics) | `comic` |
| other | unknown | `comic` |

**Intended:** treat the integer codes as an **interop detail**, not the rule. The rule is the media class. A reimplementation that owns its library rows should store a media class and never branch on a raw integer.

**Why one mapping (D1).** The reference duplicated the enum literals in four places and shipped two bugs as a result: a **no-op volume filter** (a branch that never fired) and an inconsistent **book-only guard** (one path applied a Books-only restriction that another path did not). A single total function removes the class of bug.

**Downstream behaviour by media class:**

| Behaviour | manga | comic | book |
|---|---|---|---|
| Embedded metadata format | ComicInfo | ComicInfo | OPF (EPUB) |
| Target extension (comic archive) | `cbz` | `cbz` | n/a |
| Default file-name shape | `Series vVV cNNN` | `Series vVV #NNN` | `I6` canonical book name |
| Provider media class | `manga` | `comic` | `book` |
| `Volume` field | permitted | **suppressed** (see note) | permitted |

*Note.* Volume is suppressed for comics because the reference server forks a comic series when the embedded comic metadata carries a volume the folder does not encode. That is an integration artefact of the reference server and is **deliberately not specified as a general rule** ([§9](#9-deliberately-not-specified)); a reimplementation should suppress `Volume` only if its own scanner has the same property.

### 8.2 File kind mapping (`T2`)

**Statement.** Map a file extension to a **file kind**, which decides how the file is inspected and how it is rebuilt.

```
function fileKind(ext):
    if ext == "epub" or ext in KINDLE_EXTENSIONS: return "epub"
    if ext == "pdf":                              return "pdf"
    return "comic"                                # cbz, cbr, cb7, zip, rar, 7z
```

`KINDLE_EXTENSIONS = { mobi, azw, azw3 }`. Kindle formats are converted to EPUB on completion, so downstream they are EPUBs.

**Accepted extension → allowed detected content.** The upload gate accepts a file only if its sniffed content type is allowed for its extension:

| Extension | Allowed detected content |
|---|---|
| `cbz`, `cbr`, `cb7`, `zip`, `rar`, `7z` | zip, rar, 7z |
| `epub` | epub |
| `pdf` | pdf |
| `mobi`, `azw`, `azw3` | mobi |

Comic archives are often mislabelled (a `.cbr` that is really a zip), so all comic/archive extensions accept any of the three archive signatures. Kindle extensions are accepted only in a **book** library.

**Worked examples.**

| ext | file kind | target extension |
|---|---|---|
| `cb7` | `comic` | `cbz` |
| `cbr` | `comic` | `cbz` |
| `epub` | `epub` | `epub` |
| `pdf` | `pdf` | `pdf` |
| `mobi` | `epub` (after conversion) | `epub` |

---

## 9. Deliberately not specified

The following behaviours exist in the reference implementation **only to satisfy one particular downstream reader**. They are **not** general rules and must **not** be ported as correctness. They are listed here so a reimplementer knows they were considered and deliberately excluded.

1. **`<Volume>` suppression in comic metadata.** The reference server forks a comic series when the embedded comic metadata carries a volume the folder does not encode, and a folder scan then drops the file. The reference therefore never writes a `Volume` into a comic's `ComicInfo.xml`. This is an artefact of that server's scanner, not a rule about comic metadata. Excluded from the field-write rule ([§4.3.2](#432-write-m4)); a reimplementation should only suppress `Volume` if its own scanner has the same property. (The *ability* to drop a field is specified — the `drop` parameter of `M4` — but the *policy* of always dropping `Volume` for comics is not.)
2. **EPUB `<guide>` sanitisation.** The reference strips a broken `<guide>` element from an OPF because one reader rejects it. This is reader-specific repair, not metadata mapping. Excluded from `M6`.
3. **Bare-`&` escaping in OPF/NCX.** The reference escapes bare ampersands that one reader rejects as invalid XML. Reader-specific repair. Excluded from `M6`.
4. **`mimetype`-first, uncompressed repack.** The reference writes an EPUB's `mimetype` entry first and uncompressed. This is required by the EPUB container format for a *valid* EPUB, but the reference also applies it as a repack step; the general rule here is simply "an EPUB's `mimetype` entry, if present, is the first entry and is stored uncompressed". No other repack-ordering behaviour is specified.

---

## 10. Conformance

- A **machine-readable corpus** (JSON or YAML) of `(input → expected output)` cases will accompany this document. Each case is tagged with a rule ID (e.g. `N4`, `P1`, `M7`, `G1`).
- Both the reference tool and any reimplementation should run the corpus. Running it on both sides turns the historically implicit, hand-mirrored duplication into a checked contract.
- **Where the corpus and this text disagree, this text wins.** The corpus is a convenience and a regression net; the prose is authoritative. Report corpus/spec disagreements against the rule ID.
- Rule IDs are stable within a major version. Additions that do not change behaviour bump the minor version; behaviour changes bump the major version.

### Rule ID index

| ID | Rule | Section |
|---|---|---|
| `N1` | Release-noise vocabulary | §1.1 |
| `N2` | `isNoiseGroup` | §1.2 |
| `N3` | `dropOrphanBrackets` | §1.3 |
| `N4` | `cleanName` | §1.4 |
| `N5` | `volumeInSeries` | §1.5 |
| `N6` | `dedupeSeriesVolume` | §1.6 |
| `N7` | `cleanBookTitle` | §1.7 |
| `I1` | `baseOf` | §2.1 |
| `I2` | `normaliseNumber` | §2.2 |
| `I3` | `stripSeriesMarker` | §2.3 |
| `I4` | `guessFromFilename` | §2.4 |
| `I5` | `bookMediaDefaults` | §2.5 |
| `I6` | `canonicalBookName` | §2.6 |
| `I7` | Manga/comic filename shapes | §2.7 |
| `P1` | `safeSegment` (200-byte cap) | §3.1 |
| `P2` | `splitName` | §3.2 |
| `P3` | `targetExtension` | §3.3 |
| `P4` | Natural order | §3.4 |
| `M1` | Field set | §4.1 |
| `M2` | Age-rating vocabulary | §4.2 |
| `M3` | ComicInfo read | §4.3.1 |
| `M4` | ComicInfo write | §4.3.2 |
| `M5` | OPF read | §4.4.1 |
| `M6` | OPF write | §4.4.2 |
| `M7` | Unified field validation | §4.5 |
| `S1` | Upload statuses & transitions | §5.1–§5.2 |
| `S2` | Placement safety | §5.4 |
| `G1` | `mergeRecords` | §6 |
| `D1` | Duplicate guard | §7 |
| `T1` | Library type → media class | §8.1 |
| `T2` | File kind mapping | §8.2 |
