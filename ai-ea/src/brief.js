'use strict';

// The daily brief.
//
// The brief is the product's visible surface — for most clients it is the only
// part they read every day, so it is held to one rule: the principal should be
// able to act on the whole thing in under five minutes and should never have to
// ask "so what do you need from me?"
//
// That means decisions come first, evidence comes second, and completed work
// comes last but is never omitted. The last part matters commercially: an
// assistant whose work is invisible looks expensive.

const { triageQueue, followUpPlan } = require('./ledger');
const { formatMoney } = require('./taxonomy');

function isPlainObject(value) {
  return Boolean(value) && Object.getPrototypeOf(value) === Object.prototype;
}

/**
 * Render an instant in the principal's own timezone.
 *
 * Falls back to UTC rather than throwing: a misconfigured timezone should
 * degrade the brief's formatting, never stop it being delivered.
 */
function localTime(iso, timezone) {
  for (const zone of [timezone, 'UTC']) {
    if (!zone) continue;
    try {
      return new Intl.DateTimeFormat('en-GB', {
        hour: '2-digit', minute: '2-digit', hour12: false, timeZone: zone,
      }).format(new Date(iso));
    } catch {
      // Unknown zone; fall through to UTC.
    }
  }
  return iso.slice(11, 16);
}

function timezoneLabel(timezone) {
  return timezone && timezone !== 'UTC' ? timezone.split('/').pop().replace(/_/g, ' ') : 'UTC';
}

function normalizeEvent(input, index) {
  if (!isPlainObject(input)) throw new Error(`calendar event ${index} must be an object`);
  const start = Date.parse(input.start);
  const end = Date.parse(input.end ?? input.start);
  if (Number.isNaN(start) || Number.isNaN(end)) {
    throw new Error(`calendar event ${index} has an unparseable start or end`);
  }
  if (end < start) throw new Error(`calendar event ${index} ends before it starts`);
  return {
    id: input.id ? String(input.id) : `event-${index}`,
    title: String(input.title ?? 'Untitled'),
    start,
    end,
    startIso: new Date(start).toISOString(),
    endIso: new Date(end).toISOString(),
    attendees: Array.isArray(input.attendees) ? input.attendees.map(String) : [],
    location: input.location ? String(input.location) : null,
    // Travel and flights are the events that break a day when they collide, so
    // they are typed rather than inferred from the title at read time.
    kind: input.kind ? String(input.kind) : 'meeting',
  };
}

/**
 * Overlapping events, and the gaps too small to be useful.
 *
 * The second half matters more than it looks: a calendar with no conflicts but
 * with a 45-minute cross-town gap between two in-person meetings is still a
 * calendar that is about to fail.
 */
function calendarProblems(events, { minimumGapMinutes = 15 } = {}) {
  const sorted = [...events].sort((a, b) => a.start - b.start || a.id.localeCompare(b.id));
  const problems = [];

  for (let i = 0; i < sorted.length - 1; i += 1) {
    const current = sorted[i];
    const next = sorted[i + 1];

    if (next.start < current.end) {
      const overlapMinutes = Math.round((current.end - next.start) / 60000);
      problems.push({
        kind: 'conflict',
        severity: 'blocking',
        events: [current.id, next.id],
        message: `"${current.title}" and "${next.title}" overlap by ${overlapMinutes} min.`,
      });
      continue;
    }

    const gapMinutes = Math.round((next.start - current.end) / 60000);
    if (gapMinutes < minimumGapMinutes) {
      const bothPhysical = Boolean(current.location) && Boolean(next.location)
        && current.location !== next.location;
      problems.push({
        kind: bothPhysical ? 'travel-gap' : 'tight-turnaround',
        severity: bothPhysical ? 'blocking' : 'advisory',
        events: [current.id, next.id],
        message: bothPhysical
          ? `${gapMinutes} min between "${current.title}" at ${current.location} and "${next.title}" at ${next.location}.`
          : `${gapMinutes} min between "${current.title}" and "${next.title}".`,
      });
    }
  }
  return problems;
}

function sameDay(instantMs, dayIso) {
  return new Date(instantMs).toISOString().slice(0, 10) === dayIso;
}

/**
 * Assemble the brief.
 *
 * `commitments` is the ledger state (a Map from `reduceEvents`, or any
 * iterable of commitments). Everything else is optional; a brief with only a
 * ledger behind it is still a useful brief.
 */
function buildBrief({
  now,
  profile,
  commitments = [],
  calendar = [],
  pendingApprovals = [],
  financeSnapshot = null,
} = {}) {
  const nowIso = new Date(now ?? Date.now()).toISOString();
  const today = nowIso.slice(0, 10);
  const options = profile?.slaOverrides ? { slaOverrides: profile.slaOverrides } : {};

  const queue = triageQueue(commitments, nowIso, options);
  const chases = followUpPlan(commitments, nowIso, options);
  const events = calendar.map(normalizeEvent).filter(event => sameDay(event.start, today));
  const problems = calendarProblems(events);

  const overdue = queue.filter(row => row.state === 'overdue');
  const dueTodayAll = queue.filter(row => row.state === 'due-now' || row.state === 'unacknowledged');
  const stalled = queue.filter(row => row.needsEscalation);

  // One item, one place. A brief that lists the same commitment under
  // decisions, due-today and chasing makes three problems out of one and
  // trains the reader to skim — which is how the real decision gets missed.
  const raisedAsDecision = new Set(stalled.map(row => row.commitment.id));
  const dueToday = dueTodayAll.filter(row => !raisedAsDecision.has(row.commitment.id));

  // Decisions are the only section the principal is obliged to read, so the
  // definition of "decision" is kept narrow: an explicit approval request, or
  // something that has demonstrably stopped moving without their weight.
  const decisions = [
    ...pendingApprovals.map(approval => ({
      kind: 'approval',
      id: String(approval.id ?? 'approval'),
      ask: String(approval.ask ?? 'Approval needed'),
      context: approval.reason ? String(approval.reason) : null,
      waitingSince: approval.since ? String(approval.since) : null,
      recommendation: approval.recommendation ? String(approval.recommendation) : null,
    })),
    ...stalled.map(row => ({
      kind: 'stalled',
      id: row.commitment.id,
      ask: `${row.commitment.title} — ${row.commitment.waitingOn} has not responded after ${row.commitment.nudgeCount} ${row.commitment.nudgeCount === 1 ? 'chase' : 'chases'}. Do you want to push, or should I let it go?`,
      context: row.reason,
      waitingSince: row.commitment.lastNudgedAt,
      recommendation: null,
    })),
  ];

  const closedToday = [];
  for (const commitment of (commitments.values ? commitments.values() : commitments)) {
    if (commitment.closedAt && sameDay(Date.parse(commitment.closedAt), today)) {
      closedToday.push({
        id: commitment.id,
        title: commitment.title,
        status: commitment.status,
        reason: commitment.closeReason,
      });
    }
  }

  const firstEvent = events.length ? events.reduce((a, b) => (a.start <= b.start ? a : b)) : null;
  const lastEvent = events.length ? events.reduce((a, b) => (a.end >= b.end ? a : b)) : null;
  const bookedMinutes = events.reduce((sum, event) => sum + (event.end - event.start) / 60000, 0);

  const visibleOverdue = overdue.filter(row => !raisedAsDecision.has(row.commitment.id));
  const visibleChases = chases.filter(chase => !raisedAsDecision.has(chase.id));

  return {
    generatedAt: nowIso,
    forDate: today,
    principal: profile?.principal ?? null,
    timezone: profile?.timezone ?? 'UTC',
    decisions,
    calendar: {
      count: events.length,
      firstStart: firstEvent?.startIso ?? null,
      lastEnd: lastEvent?.endIso ?? null,
      bookedHours: Number((bookedMinutes / 60).toFixed(2)),
      problems,
      events: events.map(event => ({
        id: event.id,
        title: event.title,
        start: event.startIso,
        end: event.endIso,
        location: event.location,
      })),
    },
    overdue: visibleOverdue.map(summariseRow),
    dueToday: dueToday.map(summariseRow),
    chasing: visibleChases,
    onDeck: queue
      .filter(row => row.state === 'due-soon' || row.state === 'on-track')
      .slice(0, 10)
      .map(summariseRow),
    finance: financeSnapshot
      ? {
        unreceiptedTotal: formatMoney(financeSnapshot.unreceiptedCents ?? 0),
        unreceiptedCount: financeSnapshot.unreceiptedCount ?? 0,
        readiness: financeSnapshot.readiness ?? null,
        note: financeSnapshot.note ?? null,
      }
      : null,
    closedToday,
    counts: {
      live: queue.length,
      // Every count below is the length of the list actually printed under it.
      decisions: decisions.length,
      overdue: visibleOverdue.length,
      dueToday: dueToday.length,
      chasing: visibleChases.length,
      closedToday: closedToday.length,
    },
  };
}

function summariseRow(row) {
  return {
    id: row.commitment.id,
    title: row.commitment.title,
    lane: row.commitment.lane,
    priority: row.commitment.priority,
    owner: row.commitment.owner,
    waitingOn: row.commitment.waitingOn,
    dueAt: row.commitment.dueAt,
    state: row.state,
    why: row.reason,
    source: row.commitment.source,
  };
}

function bullet(text) {
  return `- ${text}`;
}

const CALENDAR_PROBLEM_LABELS = Object.freeze({
  conflict: '**Double-booked**',
  'travel-gap': '**Not enough travel time**',
  'tight-turnaround': 'Tight turnaround',
});

function plural(count, singular, pluralForm) {
  return count === 1 ? singular : (pluralForm ?? `${singular}s`);
}

/**
 * Render the brief as the message that actually gets sent.
 *
 * Plain Markdown on purpose: it reads correctly in email, Slack, Notion and a
 * terminal without a rendering step, and the client can forward it without it
 * falling apart.
 */
function renderBrief(brief) {
  const lines = [];
  const { counts } = brief;

  lines.push(`# Daily brief — ${brief.forDate}`);
  if (brief.principal) lines.push(`For ${brief.principal}.`);
  lines.push('');
  lines.push(
    `**${counts.decisions} ${plural(counts.decisions, 'needs', 'need')} you · ${counts.overdue} overdue · `
    + `${counts.dueToday} due today · ${counts.chasing} being chased · `
    + `${counts.closedToday} closed since yesterday**`,
  );
  lines.push('');

  if (brief.decisions.length > 0) {
    lines.push(`## Needs a decision from you (${brief.decisions.length})`);
    for (const decision of brief.decisions) {
      lines.push(bullet(`**${decision.ask}**`));
      if (decision.context) lines.push(`  - ${decision.context}`);
      if (decision.recommendation) lines.push(`  - My recommendation: ${decision.recommendation}`);
    }
    lines.push('');
  } else {
    lines.push('## Needs a decision from you');
    lines.push('Nothing. Everything live is either mine to move or waiting on a clock, not on you.');
    lines.push('');
  }

  lines.push(`## Today's shape`);
  if (brief.calendar.count === 0) {
    lines.push('No meetings scheduled.');
  } else {
    const zone = brief.timezone ?? 'UTC';
    lines.push(
      `${brief.calendar.count} ${plural(brief.calendar.count, 'meeting')}, `
      + `${brief.calendar.bookedHours}h booked, `
      + `${localTime(brief.calendar.firstStart, zone)}–${localTime(brief.calendar.lastEnd, zone)} `
      + `${timezoneLabel(zone)}.`,
    );
    // A count is not an agenda. The principal reading this at 7am wants to know
    // what the day actually contains, in their own timezone.
    for (const event of brief.calendar.events) {
      lines.push(bullet(
        `${localTime(event.start, zone)}–${localTime(event.end, zone)} ${event.title}`
        + `${event.location ? ` — ${event.location}` : ''}`,
      ));
    }
    for (const problem of brief.calendar.problems) {
      lines.push(bullet(`${CALENDAR_PROBLEM_LABELS[problem.kind]} — ${problem.message}`));
    }
  }
  lines.push('');

  if (brief.overdue.length > 0) {
    lines.push(`## Overdue (${brief.overdue.length})`);
    for (const row of brief.overdue) {
      lines.push(bullet(`**${row.title}** — ${row.why} _(${row.lane}, ${row.priority}; from ${row.source})_`));
    }
    lines.push('');
  }

  if (brief.dueToday.length > 0) {
    lines.push(`## Due today (${brief.dueToday.length})`);
    for (const row of brief.dueToday) {
      lines.push(bullet(`**${row.title}** — ${row.why}`));
    }
    lines.push('');
  }

  if (brief.chasing.length > 0) {
    lines.push(`## I'm chasing (${brief.chasing.length})`);
    for (const chase of brief.chasing) {
      lines.push(bullet(
        `${chase.title} — ${chase.action === 'escalate' ? 'escalating to you' : `chase #${chase.attempt} to ${chase.waitingOn}`}. ${chase.reason}`,
      ));
    }
    lines.push('');
  }

  if (brief.finance) {
    lines.push('## Money');
    const count = brief.finance.unreceiptedCount;
    lines.push(bullet(
      `${count} ${plural(count, 'charge')} totalling ${brief.finance.unreceiptedTotal} `
      + `${plural(count, 'has', 'have')} no receipt behind ${plural(count, 'it', 'them')}.`,
    ));
    if (brief.finance.readiness !== null) {
      lines.push(bullet(`Tax file readiness: ${brief.finance.readiness}%.`));
    }
    if (brief.finance.note) lines.push(bullet(brief.finance.note));
    lines.push('');
  }

  if (brief.onDeck.length > 0) {
    lines.push('## On deck');
    for (const row of brief.onDeck) {
      lines.push(bullet(`${row.title} — ${row.why}`));
    }
    lines.push('');
  }

  // Kept last and never dropped: this is the section that answers "what am I
  // paying for" without anyone having to ask.
  lines.push('## Closed since yesterday');
  if (brief.closedToday.length === 0) {
    lines.push('Nothing closed out today.');
  } else {
    for (const row of brief.closedToday) {
      lines.push(bullet(`${row.title}${row.status === 'dropped' ? ` — dropped: ${row.reason}` : ''}`));
    }
  }

  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n').trim()}\n`;
}

module.exports = {
  CALENDAR_PROBLEM_LABELS,
  localTime,
  normalizeEvent,
  calendarProblems,
  buildBrief,
  renderBrief,
};
