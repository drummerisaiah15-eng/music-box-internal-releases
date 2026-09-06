---
name: calendar-and-travel
description: Manage an executive calendar and book travel — scheduling, conflict resolution, protected time, buffers, and itineraries. Use when asked to schedule, reschedule, find time, fix a calendar, protect focus time, or arrange a trip.
---

# Calendar and travel

A calendar is a plan for a body that has to be in places. Most calendar failures
are not double-bookings; they are two meetings that fit perfectly on a grid and
twenty minutes apart in the real world.

## Before touching anything

Run `virtual-ea brief` and read the day's problems. The engine reports three
kinds, and they are not the same:

- **Double-booked** — genuine overlap. Fix it now.
- **Not enough travel time** — different locations, no gap. Fix it now; this is
  the one that actually strands the principal.
- **Tight turnaround** — same place, thin gap. Flag it, do not necessarily fix.

## Scheduling rules

- **Buffers are part of the meeting.** Anything requiring travel gets travel
  time booked as its own block, at real-world duration plus a margin, not
  Maps' optimistic number.
- **Protect the principal's stated focus time** before accepting anything into
  it. If a request must break it, that is a decision for the brief, not
  something you absorb quietly.
- **Never propose a slot you have not verified is free** across every calendar
  they keep, including personal.
- **Quiet hours are real.** Do not schedule into them, and do not send meeting
  invitations that land during them.
- **Time zones in writing, always.** "Thursday 2pm ET" — never bare "2pm". When
  a trip crosses zones, state which zone each item is in.

## Rescheduling and cancelling

Moving a meeting costs other people their plans, so it goes through
`virtual-ea authority` — anything that notifies attendees immediately is
confirmed first. When you do move something:

1. Offer the new time to the party who did not cause the move.
2. Say why, briefly and honestly. Not "a conflict came up" when the truth is
   "Dana is travelling and I should have caught this."
3. Log the reschedule against the original commitment so the record shows the
   promise moved rather than vanished.

## Travel

Book the trip, then build the document the principal actually uses: one page,
chronological, everything in local time, with confirmation numbers inline.

Every trip produces:

- Flights, hotel, ground — with confirmation numbers and cancellation deadlines.
- The meetings the trip exists for, with addresses and the travel time between.
- What happens if the first flight is cancelled: the alternative, already found.
- Receipts filed as you go (`docType: "RECEIPT"`, `category: "travel"`, with a
  `businessPurpose`), not reconstructed a month later from a card statement.

Log the cancellation deadline as its own commitment. A refundable booking that
silently becomes non-refundable is money lost to nothing but a missing clock.
