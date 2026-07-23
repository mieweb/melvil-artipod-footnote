# Chunking directions — what I built and what it costs

Context: after the progress video, the next task was to explore chunking. This
covers the three pieces I built and the one I priced out. Everything is on branch
`feat/chunking-directions` (off `feat/assertion-metadata-phase2`), committed
locally, **not pushed**.

TL;DR:
- **#1 filename-in-chunk** — done, committed. Cheap win, no dependencies.
- **#2 grammar-aware splitting** — done, committed. Cheap win, no dependencies.
- **#4 AI-to-markdown** — prototyped and **priced**, not shipped. This is the
  "expensive but effective" path. Real numbers below.

Tests: **110/110 green**. `tsc` clean except one pre-existing unrelated error in
`gazetteer.test.ts` (a one-character `.ts`→`.js` fix from an earlier session).

---

## #1 — Put the document's name in the chunk  (commit `2bc5e06`)

**What.** Each chunk already carries its heading trail into the text we embed
(`Section: A > B > C.`). Now it also carries the source document's title, one level
up:

```
Source: Mental Health Working Group.      ← new
Section: Recommendations.
- Increase monitoring cadence.
```

**Why.** A chunk like a bare "Recommendations" list had no idea which report it
came from. Embedding it with the document's title gives it that topical signal, so
searching "mental health workplace recommendations" pulls the right report's
section instead of every document that happens to have a "Recommendations" heading.

**Honest scope.** This only changes the *embedding fingerprint* — the text we turn
into a vector. The stored/displayed chunk text is untouched. The title we use is the
front-matter title if present, else the file's basename (extension stripped) — never
a long absolute path, which would just add noise.

**Catch.** Because the embedding text changed, the vector-version marker was bumped
(`RENDER_VERSION` 2 → 3). It only takes effect after a **re-index** (`--clean`).

---

## #2 — Don't cut a chunk in the middle of something  (commit `86003de`)

**What.** When a section is too big and has to be split, the splitter used to cut on
any `.`/`!`/`?`/newline. That could slice through the middle of:
- a parenthetical: `(dosing: 1.5 mg then 2.5 mg per protocol A.B.C.)`
- a decimal or abbreviation: `1.5`, `e.g.`, `U.S.A.`
- a bracketed citation: `[Smith et al. 2020]`
- a fenced code block (periods and blank lines inside it)

Now the splitter tracks how deep it is inside `()[]{}`, quotes, inline code, and
` ``` ` fenced blocks, and **only splits when everything is closed**. A period only
ends a sentence when it's followed by a space or the end of text — so `1.5` and
`e.g.` stay intact.

**Safety valve.** If one balanced thing is itself bigger than the chunk budget (a
giant parenthetical, a huge code block, or a stray unmatched quote), it still gets
force-split at a space so a chunk can never blow up unbounded.

**Honest scope.** Deliberately does *not* track single quotes / apostrophes —
otherwise `don't` and `patients'` would look like the start of a quote and break
normal English. Documented in the code.

---

## #4 — Have an AI rewrite the messy PDF first  (prototype only — priced, not shipped)

**The idea Doug raised:** for messy PDFs, instead of parsing them with rules, hand
the raw extracted text to an LLM, have it rewrite clean Markdown (proper headings,
lists, rejoined sentences), and chunk *that*. The question was never "does it work"
— it's "what does it cost." So I built a prototype (`ai-markdown-demo.ts`) that runs
the real pipeline both ways on our actual IOMSC PDFs and measures it.

Model: `qwen2.5:7b-instruct` running locally in Ollama (free, on-device — no new
paid dependency to get a number).

### Quality — before vs after (Mental Health WG, 7 pages)

| | current heuristic parse | AI cleanup |
|---|---|---|
| headings found | 10 — raw ALL-CAPS runs like `PRIORITY 1: PRIMARY INTERVENTIONS – PREVENTING HARM MOST EFFECTIVE` | 14 — a real hierarchy: a proper title, `1. Introduction`, `2. Priorities and Interventions`, … |
| other | — | even repaired a column-break typo: `Th ought` → `Thought` |

The heuristic gets the PDF's font sizes (the AI only got raw text with no layout),
and the AI *still* produced cleaner structure. That's the interesting result.

### The numbers (the point of the exercise)

Two things move independently, so keep them separate:

- **Cost is stable** (it's per-token): about **1.5¢/doc on Claude Haiku 4.5**, or
  **4.6¢/doc on Claude Sonnet 5**, for these ~7-page documents. Locally in Ollama
  it's **$0** — you pay compute/time, not per token.
- **Latency is machine-dependent.** On an idle Mac the 7B model ran ~14 tokens/sec
  (≈ 3 min/doc); under load it dropped to ~5.5 tokens/sec (≈ 7 min/doc). A 27-page
  document is ~5,000 output tokens — several minutes on its own.

Full run across all four IOMSC PDFs:

| document | pages | words | input tok | output tok | warm s | Haiku 4.5 | Sonnet 5 |
|---|---|---|---|---|---|---|---|
| Climate Change | 7 | 2,144 | 2,983 | 2,462 | 447 | $0.015 | $0.046 |
| Mental Health | 7 | 1,990 | 2,817 | 2,476 | 489 | $0.015 | $0.046 |
| Business Plan | 7 | 2,511 | 3,396 | 1,242 | 277 | $0.0096 | $0.029 |
| Proceedings | 27 | 4,919 | 6,413 | 3,363 | 746 | $0.023 | $0.070 |

**Read the cost three ways** — per doc hides length, so normalize:

| unit | Haiku 4.5 | Sonnet 5 | note |
|---|---|---|---|
| per document | 1–2¢ (7pp) · 2.3¢ (27pp) | 3–7¢ | worst unit — a "doc" is 7 or 27 pages |
| per page | ~0.1–0.2¢ | ~0.3–0.7¢ | good for sizing a corpus; assumes ~300 words/page |
| per 1k tokens | ~0.2–0.3¢ | ~0.6–0.9¢ | the true rate — cost is literally tokens × price |

The real unit is **tokens**; page cost is a planning proxy that drifts with text
density (these docs ran 182–359 words/page) and with how verbose the rewrite is
(output tokens are the pricier, model-controlled side). Use **per-page to size a
job, per-1k-tokens for accuracy, never per-doc.** Latency this pass ran slow
(~4.5–5.5 tokens/sec, the Mac was under load) vs ~14 tokens/sec idle — **the token
cost is predictable, the wall-clock is not.**

### Is it actually *better*? — benchmark (directional)

Cleaner-looking structure isn't the same as better retrieval, so I built a benchmark
(`bench-chunking.ts`): pool every doc's chunks into one index and retrieve across the
whole corpus (realistic), hold everything constant except the config under test, and
score each end-to-end — 12 questions generated from the raw source text (blind to any
chunking), retrieve top-4 → generate an answer → judge it 1–5 vs the gold answer.
Fully local (qwen2.5:7b + nomic-embed). Small-N, local judge → **directional**.

| config | answer /5 | answerable | retr@4 | chunks |
|---|---|---|---|---|
| heuristic (no filename) | 4.00 | 75% | 42% | 37 |
| **heuristic (+filename #1)** | 4.00 | 75% | **50%** | 37 |
| ai-md (naive prompt) | 3.67 | 67% | 42% | 37 |
| ai-md (constrained prompt) | 3.50 | 67% | 42% | 63 |

Three findings:

1. **#1 (filename) helps retrieval.** retr@4 rose **42% → 50% (+8 pts)** — better
   routing to the right document. Final answer score was flat only because a 3-doc
   corpus is too small for wrong-document errors to bite; on a large corpus that +8
   pts is where it pays. retr@4 has no LLM in the scoring, so it's the trustworthy
   signal — #1 earned its keep.
2. **Prompt engineering did NOT rescue AI-markdown — it backfired.** Constraining the
   7B ("only #/##, never headline a sentence, keep every sentence") made fragmentation
   *worse* — **63 chunks vs 37** — because, barred from `###`, it flooded the doc with
   `##` sections. A 7B won't reliably follow structural rules. Essentially a wash
   (−0.17 is noise at N=12).
3. **AI-markdown (local 7B) still loses to the heuristic** (−0.50), on both prompts —
   confirmed twice.

**One caveat toward the heuristic:** questions/gold answers came from verbatim source
text, which the heuristic preserves and the AI paraphrases — so the AI gap is somewhat
overstated. Even so, local-model AI-markdown is at best a wash *with* a cost + latency
penalty.

**Bottom line:** naive AI-to-markdown with a *small local model* is **not worth it** —
prettier, but not better retrieval, and prompt-tuning didn't fix it. The one untested
lever is a **stronger (paid) model** (~1.5¢/doc on Haiku), which is the most likely
thing to flip it, because both failure modes — ignoring structure rules and dropping
content — are exactly what a bigger model handles better. That's the cheap, concrete
next experiment; needs an API key set. Meanwhile #1 is a measured, shipped win, and
the whole exercise is evidence for the **lightweight** side of the lightweight-vs-
top-tier call.

### Unlimited-OCR spike (Doug's pointer) — first evidence

Doug pointed at `baidu/Unlimited-OCR` (specialized doc-parsing model, ~93 OmniDocBench,
self-hostable/MIT — relevant for PHI). We ran our real PDFs through it two ways: the
official HF Space (A100-class) and a free Colab T4. Findings:

1. **Structure is layout-text, not markdown.** Zero `#` headings in its output; a
   "convert to markdown." prompt breaks generation entirely (it only speaks its trained
   prompts). Adopting it requires our own heading-inference shim — real integration cost.
2. **Fidelity errors on the hard regions, even on good hardware.** The Space run
   nailed prose and reading order (and fixed pdfjs's `Th ought` split), but the angled
   contributors table came back with misspelled orgs (Corteva→"Cortevia",
   Corning→"Coming"), a duplicated name, and three truncated "Dr. C / Dr. E / Dr. A"
   stubs.
3. **On budget hardware it hallucinates.** Same model + docs on a free T4: names
   rewritten wholesale (Heron→"Baron", Haleon plc→"Hélène Plic"), **"more than 50
   CMOs" became "more than 60"** (a *number* flip — clinically that's a dose), whole
   sections duplicated, one doc truncated at 2/7 pages.

**Deployment is part of the model.** We proved it: whole-page mode on a free T4
hallucinated (Heron→Baron, "50 CMOs"→"60"); switching to the Space's actual **crop
mode** on the *same* free T4 fixed it — output ≈ A100 Space quality. So cheap
self-hosting is viable ONLY with the right pipeline (crop mode + a heading shim +
output validation).

**Full benchmark (5 parsers, same 12 questions, whole-corpus retrieval, Haiku referee).**
retr@4 is pure vector math (no model in the scoring); answer/5 is model-graded:

| parser | answer/5 | answerable | retr@4 | chunks | Δ vs heuristic |
|---|---|---|---|---|---|
| heuristic (current) | 3.67 | 67% | 50% | 37 | — |
| ai-md qwen-7B | 3.67 | 67% | 42% | 36 | +0.00 |
| ai-md Haiku 4.5 | 3.83 | 75% | 42% | **60** | +0.17 |
| **ai-md Sonnet 5** | **4.33** | **83%** | 50% | 42 | **+0.67** |
| **unlimited-ocr (crop)** | 4.00 | 75% | **58%** | 40 | +0.33 |

**This overturned an earlier conclusion.** With only qwen-7B tested, AI-rewriting
looked like a dead end. It wasn't — **rewrite quality scales with model capability**,
and so does structural restraint: qwen 36 chunks, Haiku over-heads to 60 (retrieval
drops to 42%), Sonnet settles at 42 and wins outright on answers. The "AI rewriting
over-fragments" claim was really "*small* models over-fragment."

**But nobody wins outright — they win at different things:**

| option | strength | cost | PHI |
|---|---|---|---|
| heuristic | free, instant, copies exact bytes | $0 | fine |
| Sonnet 5 rewrite | **best answers** (4.33) | ~5¢/doc forever | ✗ leaves our walls |
| Unlimited-OCR | **best retrieval** (58%), reads scans | GPU (≈free on our cluster) | ✓ stays in-house |

**Fidelity check** (% of the PDF's numeric facts surviving): qwen-7B **84%** (drops 8
of 51), Haiku/Sonnet/OCR **100%**. Caveat: this metric detects *vanished* numbers, not
*wrong* ones — the known-bad whole-page OCR run still scored 93% despite fabricating
"50"→"60", because "50" appears elsewhere. So 100% means "nothing dropped", NOT
"nothing altered". A context-aware check is needed before trusting any of this
clinically.

**Verdict:** no rip-and-replace is justified at N=12. The strongest argument for OCR
isn't its score — it's the **categorical** capability: it reads scanned documents the
heuristic returns *nothing* for, and it self-hosts (PHI-safe). Sonnet is the quality
leader but re-authors every sentence and can't touch patient data. Note the fidelity
ordering runs *opposite* to the score ranking: heuristic copies bytes → OCR re-reads
pixels → LLM re-authors. The best score takes the most liberties.

**Not tested:** AI-as-*chunker* (letting a model choose chunk boundaries directly).
Every config here used our same deterministic chunker; only the parser varied.

### Does this transfer to clinical documents?

These are the only PDFs in the repo — IOMSC occupational-health reports (workplace
mental health, heat exposure, a business plan, summit proceedings). They're
healthcare-*adjacent* prose, not clinical notes. Two different answers:

- **Cost and latency: yes, essentially the same.** Both are driven by token count,
  which tracks document length, not subject matter. A 7-page clinical PDF lands in
  the same penny-or-two / few-cents range.
- **Quality and *risk*: not the same — and this is the important caveat.** Clinical
  notes are denser, abbreviation-heavy, and tabular (labs, vitals, med lists), and
  the stakes of the rewrite are far higher. In a workplace report a dropped or
  reworded sentence is a nuisance; in a clinical note, dropping a finding, flipping a
  negation ("denies chest pain" → "chest pain"), or mangling a dose is a safety
  issue. A general 7B model gives **no fidelity guarantee**. And the rewrite happens
  *upstream* of footnote's negation/assertion layer, so it could corrupt the very
  section headings and polarity that layer depends on. On clinical text you'd want
  real fidelity guardrails and probably a stronger/clinical-grade model before
  trusting it — so treat the quality result here as a best case, not a transfer.
  (Easy to measure directly if we get a sample clinical PDF — same demo, one run.)

### The takeaway for the decision

- It genuinely produces better structure than the rules-based parser.
- Per-document API cost is small (pennies).
- The cost that matters is **latency + per-doc LLM spend at scale**, and the
  operational reality that every document now depends on an LLM call. Locally it's
  too slow to run on a big corpus; in production it means a hosted API bill and
  per-doc latency.
- This is the same fork as "AI-decided chunking" — both trade money/latency per
  document for quality on messy input. Pick one, don't build both.

---

## What is *not* done (so nobody over-claims)

- #4 is a **prototype to get a number**, not production code. No fidelity guardrails
  (the LLM could drop or reword content — I told it not to, but that's a prompt, not
  a guarantee).
- No re-index has been run — #1 and #2 change indexing, so they take effect on the
  next `--clean` build, not retroactively.
- Nothing is pushed; the demo and docs are untracked for me to place.

---

## Run it yourself

```bash
# tests + typecheck
npm test
npx tsc --noEmit

# see #1 + #2 on a real note
node --import tsx chunk-demo.ts

# price #4 on one PDF (or: … all)
node --import tsx ai-markdown-demo.ts "IOMSC-WG-Mental Health-V3 4.29.26.pdf"
```

## File map

- `src/render/embedding-text.ts`, `src/chunker/chunker.ts`, `src/indexer/build.ts` — #1
- `src/chunker/chunker.ts` (splitter) — #2
- `ai-markdown-demo.ts` (repo root, untracked) — #4 prototype
- Tests: `src/render/embedding-text.test.ts`, `src/chunker/chunker.test.ts`
