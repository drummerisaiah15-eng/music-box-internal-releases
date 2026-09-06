# The offer

Internal. Positioning, packaging and pricing for selling this to clients.

## What is actually being sold

Not "an AI assistant". Founders have tried those and found them to be a chat
window that forgets. What is being sold is **execution you do not have to
supervise**, and the three things that make that claim credible:

**Nothing drops.** Every promise — made to the client, by the client, or on
their behalf — is a row in an append-only ledger with an owner, a source and a
clock. Follow-up is computed, not remembered. When chasing stops working, the
system says so and asks a real question.

**Nothing goes out unapproved.** Spend limits, send allowlists, review-first
lists and sensitive topics are checked before any outbound action. Signing and
record deletion are refused in code under every configuration. The default for
anything unrecognised is to ask.

**Nothing is asserted that has not been checked.** Claims are graded on source
tier and independence — six outlets running one wire story count as one source,
and a credible contradiction outranks any amount of agreement. Recommendations
carry a confidence level and state what would change the answer.

The commercial point of all three: a human EA's reliability is a personality
trait you hire for and hope holds. Here it is a property of the system, and it
is the same on the ninetieth day as the first.

## Who it is for

Founders and operators running several things at once, with real money moving
and a bookkeeping situation they are quietly avoiding. Typically $1M–$20M
revenue, one to three entities, no chief of staff, and a CPA relationship that
costs more than it should because the file arrives in a shoebox.

**Not for:** anyone who wants a human in the room, anyone needing signature
authority delegated, and anyone whose main need is bookkeeping to close rather
than getting records to a state a bookkeeper can use.

## Packaging

Three tiers. Each is a superset of the one before.

### Essentials
Inbox triage, calendar, scheduling, daily brief, commitment ledger and
follow-through.

The pitch: *nothing gets dropped, and you read five things a day instead of
two hundred.*

### Operator
Adds project coordination, vendor and staff follow-up, travel, research briefs
with verified sources, and the weekly summary.

The pitch: *the things you keep meaning to push actually move, and when you
need a decision made properly someone digs and comes back with an answer.*

### Operator + Books
Adds finance administration: receipt and statement capture, filing to a parsable
convention, weekly reconciliation, substantiation chasing, and the year-end CPA
packet.

The pitch: *your CPA stops billing you to sort a shoebox, and you find out about
a missing receipt in March rather than the following April.*

## Pricing frame

Set your own numbers; this is the structure and the logic for adjusting it.

Price against **what the client currently pays for the same outcome**, not
against tokens. The comparison a buyer makes is to a part-time EA at
$2,500–$5,000/month for 20 hours, or a fractional chief of staff at more. Land
meaningfully under the EA number for Essentials, at or near it for Operator, and
above it for Operator + Books — because that tier replaces both the EA hours and
part of the bookkeeping spend.

Three rules that hold regardless of the numbers:

1. **Monthly retainer, not hourly.** Hourly billing makes the client ration the
   thing you want them to use more of, and rewards you for being slow.
2. **A paid onboarding fee, always.** Week one is the most labour-intensive week
   and the one that determines retention. Free onboarding attracts clients who
   will not do the intake, and those clients churn.
3. **Price the second entity separately.** A second business roughly doubles the
   finance workload and is the most common quiet scope creep.

Discount for annual prepayment if you like, never for scope. A client who
negotiates the scope down gets a worse result and blames the service.

## Proving it in the sale

The demo that closes is not a feature tour. It is:

1. **Their real backlog.** Run the backlog sweep over a folder of their actual
   threads. Show them the obligations nobody was tracking. This lands every
   time, because there are always more than they expect.
2. **Their real statement.** Run a reconciliation over one month. Show the
   charges with no receipt behind them and the dollar figure attached.
3. **A real decision they are facing.** Run the option comparison and show the
   sensitivity result — including a case where the honest answer is "leading
   candidate, not a decision". Nothing establishes credibility faster than a
   system that declines to overclaim.

## Objections worth having an answer to

**"How do I know it won't email the wrong person?"** — It cannot send outside
the allowlist. Show them the authority check refusing a send, live. The refusal
is more persuasive than any assurance.

**"What happens to my data?"** — Plain files on infrastructure they control, no
vendor database, no training on their material, deletable by removing a
directory. Hand them `DATA-HANDLING.md`.

**"Is this giving me tax advice?"** — No, and it says so on every packet it
produces. It organises records and proposes categories for the CPA to review.

**"What if I want out?"** — The whole workspace is JSON and Markdown they can
open in a text editor, plus their own documents in their own storage. There is
no export process because there is nothing to export from.

**"Can it just do it without asking me so much?"** — Yes, and that is the
onboarding conversation. The interruption rate is a direct function of how much
authority they grant, and it is designed to fall over the first quarter. Show
them the monthly metric that tracks it.
