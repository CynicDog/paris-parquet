# SQL input assistance: string algorithms and syntax-error repair

**Status: research note, with one decision recorded below.** Nothing here is implemented. It records what the literature offers for helping someone who is typing SQL into the query box, what that means for this page, and what to measure before building any of it. The numbers quoted from papers are theirs; the description of this page's code and the census of the Db2 grammar's ATN are ours.

## Decision (2026-09-19)

Keep ANTLR for parse trees and add the repair idea on top of it. There is no second (LR) parsing engine.

- **One grammar source.** Both dialect grammars are ANTLR grammars (Apache Spark's own, and the Db2 grammar used by the SQL front-end library). An LR engine would mean re-deriving both, resolving the conflicts that ANTLR settles by ordered alternatives, and keeping two grammars in step.
- **Single-file delivery is kept.** The repair search lives in the SQL front-end library and is serialized into the page's one HTML file with the rest of it: no extra file, no network request, and no second parsing engine in the payload. It runs in a worker started from the page's own script text, as the decoding workers already do.
- **No cost on valid input.** As with CPCT+ itself, the repair machinery runs only after the parser has reported an error.
- **First version:** the real parser is the oracle (design A below), measured against a mutation corpus before anything more elaborate is built.

## Where things stand

The SQL panel is a plain `<textarea id="qsql">`. A keystroke arms a 260 ms timer that calls `adoptSql`, which calls `parseSql(text, cols)` — a hand-written recursive-descent parser that turns the text into the builder's query object and reports `{ msg, at }` errors. Its suggestion machinery is `nearestName`: a full edit-distance table against each column name (candidates whose length differs by more than 3 are skipped), accepted when the distance is at most `max(2, ceil(length / 3))`. The message list under the box is the only place a suggestion appears.

In the other direction, every chip action ends in `renderSql(true)`, which assigns `el.value = querySql()`. That replaces the whole text: the user's formatting, comments, letter case, caret position and native undo history are lost. "The builder wins its own edits" is a documented choice, not an accident.

## Three different string problems

Comparing "what the user typed" with "what the application understands" is really three problems, and only one of them is what `git diff` solves.

| | problem | algorithm family | where it matters here |
|---|---|---|---|
| **A** | one typed token vs. the tokens that could be legal here | approximate string matching, ranked with priors | the "did you mean" already in place, extended to keywords, functions and tables; completion |
| **B** | a broken statement vs. the nearest valid one | minimum-cost syntax-error repair | missing or extra commas and parentheses, wrong clause order, statements cut short |
| **C** | old text vs. new text | sequence diff | keeping the user's text when chips rewrite the query; showing what a dialect switch changed |

"Partially or globally" is alignment vocabulary. Global alignment (Needleman–Wunsch) compares whole strings. Local alignment (Smith–Waterman) finds the best-matching region. Semi-global alignment (Sellers) matches a short pattern against part of a longer string, which is what completing a typed prefix against a candidate name is.

### A. Approximate matching

- **Distance:** Damerau–Levenshtein (optimal string alignment), so a transposition (`WEHRE`) costs one edit instead of two. Weight it: case differences free, `_` and camelCase boundaries free, keyboard-adjacent substitutions cheaper.
- **Completion:** fuzzy subsequence matching in the style of fzf (a Smith–Waterman variant with bonuses for word starts), so `ordamt` finds `order_amount`. Edit distance is the wrong tool for abbreviations.
- **Ranking:** a noisy-channel model (Brill and Moore, 2000). The edit distance is the likelihood of the typo; priors come from context — the clause being typed, whether a numeric column sits inside `SUM(`, columns already used, what the user picked last.
- **Candidates from the grammar, not from a global dictionary:** at a parse error, the set of tokens the grammar accepts there is far smaller than every keyword and column name.
- **When to say anything:** offer a correction only when the best candidate is clearly ahead of the second-best. An error at the end of the text or beside the caret is *incomplete*, not *wrong*, and should read as a hint.
- **Scale:** even 5,000 columns at a full table each is milliseconds. BK-trees, Levenshtein automata and SymSpell are not needed until measurement says so.

### B. Syntax-error repair

The formal statement is the minimum edit distance from the input to the grammar's language (Aho and Peterson, 1972). Exact solutions are cubic and were never practical, so the working family is *locally least-cost repair*:

- Fischer et al. (1979): at the error point, find the cheapest sequence of inserts and deletes after which the parser accepts one more symbol.
- Corchuelo et al. (2002): the same for Yacc LR parsers, adding **shift** — consuming real input for free — as a third move.
- Kim and Yi (2010): an A*-based variant.
- **CPCT+**, Diekmann and Tratt, *Don't Panic! Better, Fewer, Syntax Errors for LR Parsers* (ECOOP 2020): corrects Corchuelo's shift, merges equivalent search states, and returns the *complete set* of minimum-cost repairs, ranked.

#### CPCT+ as implemented in `grmtools`

A configuration is a parse stack, a position in the remaining tokens, and the repairs made so far, with a cost.

| move | effect | cost |
|---|---|---|
| Insert T | pretend token T appeared (any T with an action in the current state) | 1, via a per-token cost function |
| Delete | skip the next real token | 1 |
| Shift | parse the next real token | 0 |

- The search is Dijkstra ordered by cost. A delete is never followed by an insert. At most one shift is generated per step ("CR Shift 3"), so no intermediate configuration is skipped.
- **Success:** the last 3 repairs were shifts (`PARSE_AT_LEAST = 3`), or the parser reaches Accept.
- **Merging:** two configurations with the same stack and input position merge if they end in the same number of trailing shifts and either both or neither end in a delete. Merged repair sequences form a tree, like a GLR graph-structured stack.
- **Complete minimal set:** once a success at cost *c* is found, anything costing more than *c* is discarded and cost *c* is explored to the end.
- **Ranking:** each candidate is applied and the parser continues for up to 250 tokens (`TRY_PARSE_AT_MOST`); only candidates that get furthest survive.
- **Simplify:** trailing shifts are stripped, duplicates removed, and sequences are sorted so those inserting `%avoid_insert` tokens come last, then by fewer repairs. The first is applied.
- **Budget:** 0.5 s, after which no repair is reported. The paper describes the core as under 500 lines of Rust.

Reported on 200,000 real Java files:

| | CPCT+ | panic mode |
|---|---|---|
| files fully repaired within 0.5 s | 98.37% | 100% |
| mean / median time | 13.6 ms / 0.25 ms | about 0 |
| error locations reported | 435,812 | 981,628 |
| tokens skipped | 0.31% | 3.72% |

The 2.25× drop in reported errors is the "fewer errors" of the title: after a bad recovery, a parser reports phantom errors that do not exist. Costs attach to token *types*; the text of a token is ignored.

#### Related systems

| system | approach |
|---|---|
| tree-sitter | GLR; skip tokens or insert a `MISSING` node; the lowest total error cost wins |
| Lezer (CodeMirror 6) | GLR; recovery tricks tried side by side, keeping whichever parses best a few tokens later — the principle behind CPCT+'s ranking |
| ANTLR `DefaultErrorStrategy` | greedy: single-token insert or delete, otherwise skip to a token in the follow set; not a minimum-cost search |
| LaMirage (Excel and Power Fx formulas) | grammar-generated candidates, neural ranking |
| Ankou (blog experiment) | beam search over the whole file with A*-style heuristics |

### C. Diffing text

Most changes are contiguous, so the changed span of a keystroke is found by trimming the common prefix and suffix. Myers is not needed for that.

Diff proper is for the two-way sync. When chips regenerate the query, diff the user's *tokens* against the regenerated tokens and patch only the differing spans, keeping everything else as typed and mapping the caret through the edit script (what editors do with a formatter's returned edits).

- **Myers** (1986) yields a shortest edit script but can align repeated tokens (`,`, `AND`, `(`) oddly.
- **Patience** anchors on tokens unique to both texts, then recurses between them. **Histogram** anchors on the rarest token instead of requiring uniqueness.
- In SQL the natural unique anchors are the clause keywords and distinct column names, so anchoring on clauses and then running Myers inside each clause should give sensible alignments.
- The same diff, rendered, previews what a dialect switch changed (`FETCH FIRST 10 ROWS ONLY` → `LIMIT 10`).

One caveat: assigning to `textarea.value` or using `setRangeText` does not reliably preserve native undo, so this needs a decision about undo before it needs an algorithm.

Tree diff (GumTree, Zhang–Shasha, APTED) belongs to comparing two whole queries structurally, not to typing.

## What CPCT+ would need for SQL

An illustration; it has not been run. Take `SELECT CNAME, FROM ORDERS`. CPCT+ detects the error at `FROM`, because the comma was already consumed. The cost-1 repairs are: insert an expression (an identifier, a literal, `(`, …), or delete `FROM`. Deleting `FROM` gives `SELECT CNAME, ORDERS`, which also parses to the end, so lookahead ranking cannot separate the two. **Deleting the comma — what the user almost certainly meant — is not among them**, because CPCT+ only repairs at the error point (Tratt lists this as a known limitation).

Adaptations this suggests:

1. **A backtrack window.** Also start the search from the configuration one or two tokens earlier.
2. **Schema-checked repairs.** `ORDERS` is not a column, so name resolution discards "delete `FROM`". Tratt raises the missing semantic check as a caveat; here the schema makes it checkable.
3. **Filled inserts.** An identifier insert becomes "choose a column", ranked by type and context, instead of an anonymous placeholder.
4. **String-aware costs.** A misspelled keyword such as `SELCT` lexes as an identifier, so a token-type search sees "delete an identifier, insert `SELECT`" at cost 2. It should be a single replace priced by edit distance. This is where family A and family B combine.
5. **Keyword-as-identifier as a near-free edge.** Some grammars reject keyword tokens (`NAME`, `STATUS`) as column names; retyping them to identifiers can be one more low-cost move in the same search.
6. **An anytime budget.** Cost order yields cheap repairs first, so a budget of roughly 20–50 ms in a worker can return whatever cost level finished.
7. **Deterministic ties.** The reference breaks ties non-deterministically; a UI and its tests need a stable order.

Other limits from the sources: expression-heavy input can explode (Tratt reports one case with over 23,000 minimal repairs); lexer-level problems such as an unterminated string are outside a token-level search; and CPCT+ can miss obvious repairs at the very end of input, which matters for completion.

### Two ways to run it on an ANTLR parser

CPCT+ needs to advance a hypothetical configuration by one token. ANTLR is not LR, so:

- **A. The real parser as an oracle.** Catch the first error (`BailErrorStrategy` keeps the offending token, state, context and expected-token set). Generate candidates — insert each expected token, delete the offending one, pairs of these — re-parse with each edit, and score by how far it gets. Costs candidates × parse time, shares no state between trials, and works with semantic predicates for free.
- **B. An ATN walker.** A configuration is a set of ATN states with return stacks (Earley- or GLR-like). Inserts come from next-token sets, shifts step over a real token, deletes skip one. This shares work and gives an exact minimal set, but means reimplementing what ANTLR's prediction machinery does.

Measured on the ATN of the Db2 grammar the SQL front-end library uses (a census of its generated parser, September 2026): 14,536 states, 19,417 transitions, 1,028 rules. Transitions: epsilon 11,702; atom 4,419; rule call 3,063; set 219; precedence predicate 11; action 3. There are no semantic predicates, so a walker would be small — the only awkward part is the 11 precedence predicates from left-recursive rules.

Recommendation: start with A; build B only if measurement shows A is too slow.

### Bridging LR and LL

CPCT+ is described for LR parsers, but it does not need the LR grammar class. It needs a machine that can step forward one token, say which tokens are legal next, and compare two configurations for "same situation" so equivalent search states can be merged.

| machine | configuration | used by |
|---|---|---|
| LR table | a stack of states | `grmtools` CPCT+ |
| Earley or GLR | a set of items with a graph-structured stack | tree-sitter, Lezer, an Earley-based repair parser |
| ANTLR's ATN | a set of (state, return-stack) pairs | design B above |

An ATN configuration is also readable: it carries the rule call stack, so it knows it is inside the select list or the `WHERE` clause. That supplies clause-aware priors for ranking, which an LR state number does not. So the bridge is the abstract machine, not a conversion between grammar classes.

## Where the work lives

The page owns the query object, what the engine can run, the schema it passes in, the UI, and the merging of its own messages with the parser's. A separate SQL front-end library (metchurial-js) owns grammars, parsing, error information, and the repair search. It is deliberately unaware of this page, so it takes the schema as a generic input and returns ranges, expected tokens and candidate repairs. Deciding whether a repair is something the engine can run is this page's job.

## Measuring it

The project already tests against ground truth (DuckDB, fixtures, a fuzz tier), and this fits the same habit.

1. **Mutation corpus.** Take valid queries, apply one or two random edits (delete, insert, swap or substitute at character or token level), and record how often the original appears as the top suggestion and in the top three. Report it by category: keyword, function, column, punctuation, clause order.
2. **Baseline.** ANTLR's default recovery and today's `nearestName`.
3. **Ablations.** Token-type costs only, then string-aware costs, then with the backtrack window, then with the schema filter.
4. **Latency.** p95 per keystroke on a 50-line query, cold and warm, in a worker.
5. **Truncation.** Cut valid queries at every token boundary: nothing should throw, and end-of-input errors should come back as hints rather than errors.

## References

- Aho and Peterson, "A Minimum Distance Error-Correcting Parser for Context-Free Languages", *SIAM J. Comput.* 1(4), 1972.
- Fischer, Milton and Quiring, "Efficient LL(1) error correction and recovery using only insertions", *Acta Informatica* 13, 1980.
- Burke and Fisher, "A practical method for LR and LL syntactic error diagnosis and recovery", *TOPLAS* 1987.
- Corchuelo, Pérez, Ruiz-Cortés and Toro, "Repairing syntax errors in LR parsers", *TOPLAS* 24(6), 2002.
- Kim and Yi, error repair for LR parsers using A*, 2010.
- Diekmann and Tratt, "Don't Panic! Better, Fewer, Syntax Errors for LR Parsers", ECOOP 2020. <https://arxiv.org/abs/1804.07133>
- Tratt, "Automatic Syntax Error Recovery". <https://tratt.net/laurie/blog/2020/automatic_syntax_error_recovery.html>
- `grmtools` error recovery and source: <https://softdevteam.github.io/grmtools/master/book/errorrecovery.html>, <https://github.com/softdevteam/grmtools/blob/master/lrpar/src/lib/cpctplus.rs>
- Myers, "An O(ND) Difference Algorithm and Its Variations", *Algorithmica* 1986.
- Brill and Moore, "An improved error model for noisy-channel spelling correction", ACL 2000.
- Needleman and Wunsch 1970; Smith and Waterman 1981; Sellers 1980 (alignment and approximate matching).
- Falleri et al., "Fine-grained and accurate source code differencing" (GumTree), ASE 2014.
- Neurosymbolic repair for low-code formula languages (LaMirage). <https://arxiv.org/abs/2207.11765>
- Lezer guide, <https://lezer.codemirror.net/docs/guide/>; tree-sitter error recovery, <https://github.com/tree-sitter/tree-sitter/pull/101>.
