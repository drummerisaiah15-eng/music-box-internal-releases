# AI EA

A virtual executive assistant, packaged to be sold to clients: it runs
day-to-day execution across calendar, inbox, projects, finance administration
and research, and it is built so the reliability is a property of the system
rather than a promise about the assistant.

Three claims, each enforced by tested code rather than by prompt text:

| Claim | How it is enforced |
|---|---|
| Nothing drops | Every promise is a row in an append-only ledger with an owner, a source and a clock. Follow-up and escalation are computed. |
| Nothing goes out unapproved | Spend limits, send allowlists, review-first lists and sensitive topics are checked before any outbound action. Signing and record deletion are refused under every configuration. |
| Nothing is asserted that has not been checked | Claims are graded on source tier and independence; recommendations carry a confidence level and say what would change the answer. |

## Layout

```
ai-ea/
  src/                 the engine — judgement-free, tested, deterministic
  tests/               228 tests, no dependencies beyond Node
  skills/              how the assistant works: doctrine and per-area craft
  commands/            /ea-brief, /ea-triage, /ea-research, /ea-week, …
  agents/              deep research and backlog-sweep subagents
  product/             scope, SLAs, intake, data handling, pricing
  templates/           the message library
```

The split between `src/` and `skills/` is the design decision that matters.
Prompt text is persuasive but not verifiable; anything a client would be upset
to have wrong — amounts, dates, ordering, reconciliation, authority decisions —
is computed by code with tests behind it. The model supplies judgement,
drafting and explanation. The engine supplies the arithmetic and the rules.

## Quick start

```bash
npm test                                    # 228 tests, no install needed

node src/cli.js init -w ~/clients/acme --client acme
$EDITOR ~/clients/acme/client.json          # authority limits, entities, voice
node src/cli.js readiness -w ~/clients/acme # what still has to be answered
```

Then, each morning:

```bash
export AI_EA_WORKSPACE=~/clients/acme
node src/cli.js sync calendar --source gcal --mode full --json "$(fetch_events)"
node src/cli.js brief
```

Fetching is deliberately not the engine's job — that needs network, auth and a
live connector, none of which can be tested or replayed. Claude holds the
connectors and produces the records; the engine owns the merge, which is where
the hard problems are. Bank data needs no connector at all:

```bash
node src/cli.js import-csv ~/Downloads/amex-march.csv --account amex-1005
```

```
# Daily brief — 2026-09-06
For Dana Reyes.

**2 need you · 1 overdue · 0 due today · 0 being chased · 0 closed since yesterday**

## Needs a decision from you (2)
- **Approve $3,400 console purchase?**
  - Above your $250 standing limit
  - My recommendation: Approve — the quote is 18% under the next bid and the lead time is 6 weeks.
- **Studio B insurance certificate — Marcus at Halvorsen has not responded after 2 chases. Do you want to push, or should I let it go?**

## Today's shape
2 meetings, 1.92h booked, 10:00–12:00 Chicago.
- 10:00–11:00 Vendor sync — Halvorsen — Studio A
- 11:05–12:00 Bank appointment — Downtown branch
- **Not enough travel time** — 5 min between "Vendor sync — Halvorsen" at Studio A and "Bank appointment" at Downtown branch.

## Overdue (1)
- **Send signed W-9 to Sweetwater** — Overdue by 45 hours. _(finance, high; from email:thread-882)_

## Money
- 1 charge totalling $612.40 has no receipt behind it.
```

## The engine

| Command | What it does |
|---|---|
| `init` / `readiness` | Stand up a client workspace; report what is still unanswered and what each gap costs |
| `add` / `event` | Log a commitment, or an event against one |
| `queue` / `followups` | What needs attention, who to chase, what has stalled |
| `brief` | The daily brief |
| `authority` | May I do this? → `proceed` / `draft-for-approval` / `refuse` |
| `verify` | Grade a claim on source tier and independence |
| `decide` | Weighted comparison, plus whether the winner survives reweighting |
| `file` / `audit-files` | Canonical name and folder; audit an existing archive |
| `reconcile` / `cpa-packet` | Match charges to documents; year-end packet with its own gap list |
| `sync` / `import-csv` | Merge fetched records or a bank export in, preserving your own edits |
| `sync-status` | When each source last ran, and what it did |

Every command takes `--format json` for scripting and `--now` to freeze the
clock, which makes output reproducible. Full surface: `node src/cli.js --help`.

### Worth knowing

**The ledger is append-only.** History is corrected by adding a correcting
event, never by editing the past. "Who moved this due date, and when" has an
answer months later.

**Money is integer cents throughout.** Floats are how a reconciliation ends up
eleven cents out with no explanation.

**Filenames are reversible.** `parseFileName(buildFileName(x))` returns `x`, so
a filed archive is its own index — no database required to find anything. The
convention folds vendor spellings together, so one vendor cannot become two
with split year-end totals.

**Reconciliation requires exact cents.** A near-miss match looks reconciled and
is not, which is worse than an obvious gap: the gap gets investigated, the wrong
match gets filed.

**Sensitivity beats scoring.** A weighted matrix always produces a winner. The
useful question is whether that winner survives someone disagreeing with the
weights, so `decide` re-runs the ranking with each weight halved and doubled and
reports honestly when the answer is a leading candidate rather than a decision.

**Syndication is not corroboration.** Six outlets running one wire story count
as one source. `verify` counts distinct origins, not links.

**A sync never overwrites a decision.** Categories, business purposes and
entity assignments are merged three-way: the engine remembers what the feed
last supplied, so a field a person has since changed is theirs forever, while
an untouched field still improves when extraction does. A material change
underneath somebody's classification is reported rather than applied silently.

**Only a full sync can conclude something was deleted.** An incremental fetch
returns what changed, so absence means nothing — treating it as deletion would
silently empty a calendar. Withdrawn records are marked, never removed, and
drop out of briefs and reconciliations while staying in the file as history.

**A packet is scoped to one entity, not just one year.** Filtering on the year
alone put a personal receipt into the business packet and inflated the business
total with money that was never the business's — the exact mixing that
declaring entities exists to prevent. An account that names no entity is still
counted, because dropping it would hide real spending, and asked about instead.

**An ambiguous statement is refused, not guessed.** `03/04/2026` is either
3 April or 4 March, and no row in the file may prove which. The importer says
so and names the remedy rather than picking one and misfiling a quarter.

## Selling it

`product/` holds the client-facing and internal commercial material:

- **`SCOPE-AND-SLA.md`** — what is owned, what is refused, response times,
  standing deliverables, escalation triggers. Attach to the agreement.
- **`CLIENT-INTAKE.md`** — the fifteen-minute intake. Every question maps to a
  profile field; every unanswered one becomes an interruption later.
- **`DATA-HANDLING.md`** — plain files on the client's own infrastructure, no
  vendor database, no training on their material, deletable by removing a
  directory. This is the document that closes security-conscious buyers.
- **`OFFER.md`** — positioning, tiering, pricing logic, the demo that actually
  closes, and answers to the objections that come up every time.
- **`OPERATOR-RUNBOOK.md`** — how to actually run it: install, per-client setup,
  the daily and weekly rhythm, what survives a re-sync, and what to check first
  when something looks wrong.

## Scope boundary

This organises, classifies and reconciles financial records. It does not
determine deductibility and it does not give tax, legal or investment advice.
Category and Schedule C references are proposals to speed up the CPA's work,
labelled as such on every packet it produces.

Signing and record deletion are refused in code, under every configuration.
