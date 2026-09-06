'use strict';

// Command-line surface.
//
// The skills in this package drive the engine through this CLI rather than
// reimplementing its logic in prose. That split is deliberate: prompt text is
// persuasive but not verifiable, whereas everything reached through here is
// covered by tests and produces the same answer twice. Anything a client would
// be upset to have wrong — a due date, a reconciliation, a spend limit — lives
// on this side of the line.
//
// It is also what makes the product portable. A client who does not want to run
// Claude Code can call the same commands from cron, and the deliverables are
// identical.

const fs = require('node:fs');
const path = require('node:path');
const { parseArgs } = require('node:util');

const ledger = require('./ledger');
const taxonomy = require('./taxonomy');
const finance = require('./finance');
const research = require('./research');
const client = require('./client');
const brief = require('./brief');

const LEDGER_FILE = 'ledger.jsonl';
const CLIENT_FILE = 'client.json';
const DOCUMENTS_FILE = 'documents.json';
const STATEMENTS_FILE = 'statements.json';
const CALENDAR_FILE = 'calendar.json';
const APPROVALS_FILE = 'approvals.json';

class UsageError extends Error {}

function readJson(file, fallback) {
  if (!fs.existsSync(file)) {
    if (fallback !== undefined) return fallback;
    throw new UsageError(`missing required file: ${file}`);
  }
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new UsageError(`${file} is not valid JSON: ${error.message}`);
  }
}

// The ledger is JSON Lines so appending a single event is an atomic append
// rather than a read-modify-write of the whole history. Two processes filing
// commitments at once cannot lose each other's work.
function readLedger(workspace) {
  const file = path.join(workspace, LEDGER_FILE);
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8')
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        throw new UsageError(`${LEDGER_FILE} line ${index + 1} is not valid JSON: ${error.message}`);
      }
    });
}

function appendEvent(workspace, event) {
  // Validate before writing. An append-only log with a bad row in it has to be
  // repaired by hand, so the cheap moment to reject is now.
  ledger.normalizeEvent(event);
  fs.appendFileSync(path.join(workspace, LEDGER_FILE), `${JSON.stringify(event)}\n`, 'utf8');
  return event;
}

function loadProfile(workspace) {
  return client.defineClient(readJson(path.join(workspace, CLIENT_FILE)));
}

function loadState(workspace) {
  return ledger.reduceEvents(readLedger(workspace));
}

function payloadFrom(values, positionals, io) {
  if (values.input) return readJson(path.resolve(values.input));
  if (values.json) {
    try {
      return JSON.parse(values.json);
    } catch (error) {
      throw new UsageError(`--json is not valid JSON: ${error.message}`);
    }
  }
  const inline = positionals.join(' ').trim();
  if (inline) {
    try {
      return JSON.parse(inline);
    } catch (error) {
      throw new UsageError(`inline argument is not valid JSON: ${error.message}`);
    }
  }
  if (io.stdin) {
    try {
      return JSON.parse(io.stdin);
    } catch (error) {
      throw new UsageError(`stdin is not valid JSON: ${error.message}`);
    }
  }
  throw new UsageError('this command needs input: pass --input <file>, --json <text>, or pipe JSON on stdin');
}

const CLIENT_TEMPLATE = {
  clientId: 'REPLACE-ME',
  principal: 'Principal Name',
  timezone: 'America/New_York',
  entities: [
    { code: 'BIZ', name: 'Business Entity LLC', kind: 'business' },
    { code: 'PERS', name: 'Personal', kind: 'personal' },
  ],
  spendApprovalCents: 0,
  autoSendDomains: [],
  neverAutoSend: [],
  connectedSystems: [],
  voice: { register: 'direct, warm, brief', signOff: 'Thanks,', avoid: [] },
};

const COMMANDS = {
  init(workspace, { values }) {
    fs.mkdirSync(workspace, { recursive: true });
    const clientPath = path.join(workspace, CLIENT_FILE);
    if (fs.existsSync(clientPath) && !values.force) {
      throw new UsageError(`${clientPath} already exists; pass --force to overwrite it`);
    }
    const profile = { ...CLIENT_TEMPLATE, clientId: values.client ?? CLIENT_TEMPLATE.clientId };
    fs.writeFileSync(clientPath, `${JSON.stringify(profile, null, 2)}\n`, 'utf8');
    for (const [file, seed] of [
      [DOCUMENTS_FILE, []], [STATEMENTS_FILE, []], [CALENDAR_FILE, []], [APPROVALS_FILE, []],
    ]) {
      const target = path.join(workspace, file);
      if (!fs.existsSync(target)) fs.writeFileSync(target, `${JSON.stringify(seed, null, 2)}\n`, 'utf8');
    }
    if (!fs.existsSync(path.join(workspace, LEDGER_FILE))) {
      fs.writeFileSync(path.join(workspace, LEDGER_FILE), '', 'utf8');
    }
    return {
      text: `Workspace ready at ${workspace}.\nFill in ${CLIENT_FILE}, then run: virtual-ea readiness --workspace ${workspace}`,
      data: { workspace },
    };
  },

  readiness(workspace) {
    const report = client.readinessReport(loadProfile(workspace));
    const lines = [`Onboarding readiness: ${report.readiness}% (${report.operational ? 'operational' : 'not yet operational'})`];
    for (const gap of report.missing) {
      lines.push(`- ${gap.field}: ${gap.impact}`);
      lines.push(`  Ask: ${gap.ask}`);
    }
    return { text: lines.join('\n'), data: report };
  },

  add(workspace, { values, positionals, io }) {
    const input = payloadFrom(values, positionals, io);
    const at = values.at ?? new Date().toISOString();
    const event = { type: 'created', at, actor: values.actor ?? 'ea', commitment: { createdAt: at, ...input } };
    appendEvent(workspace, event);
    return { text: `Logged commitment ${input.id}.`, data: event };
  },

  event(workspace, { values, positionals, io }) {
    const event = payloadFrom(values, positionals, io);
    appendEvent(workspace, { at: values.at ?? new Date().toISOString(), ...event });
    return { text: `Logged ${event.type} on ${event.commitmentId ?? event.commitment?.id}.`, data: event };
  },

  queue(workspace, { values }) {
    const now = values.now ?? new Date().toISOString();
    const rows = ledger.triageQueue(loadState(workspace), now);
    const text = rows.length === 0
      ? 'Nothing live.'
      : rows.map(row =>
        `${String(row.urgency).padStart(5)}  ${row.state.padEnd(15)} ${row.commitment.title}\n         ${row.reason}`).join('\n');
    return { text, data: rows.map(row => ({ ...row, commitment: row.commitment })) };
  },

  followups(workspace, { values }) {
    const now = values.now ?? new Date().toISOString();
    const plan = ledger.followUpPlan(loadState(workspace), now);
    const text = plan.length === 0
      ? 'Nothing needs chasing right now.'
      : plan.map(row => `[${row.action}] ${row.title} → ${row.waitingOn} (attempt ${row.attempt})\n    ${row.reason}`).join('\n');
    return { text, data: plan };
  },

  brief(workspace, { values }) {
    const now = values.now ?? new Date().toISOString();
    const report = brief.buildBrief({
      now,
      profile: loadProfile(workspace),
      commitments: loadState(workspace),
      calendar: readJson(path.join(workspace, CALENDAR_FILE), []),
      pendingApprovals: readJson(path.join(workspace, APPROVALS_FILE), []),
      financeSnapshot: financeSnapshot(workspace, values),
    });
    return { text: brief.renderBrief(report), data: report };
  },

  authority(workspace, { values, positionals, io }) {
    const action = payloadFrom(values, positionals, io);
    const verdict = client.authorityCheck(action, loadProfile(workspace));
    return { text: `${verdict.decision.toUpperCase()}: ${verdict.reason}`, data: verdict };
  },

  file(workspace, { values, positionals, io }) {
    const record = payloadFrom(values, positionals, io);
    const fullPath = taxonomy.buildFullPath(record, values.root ? { root: values.root } : undefined);
    return { text: fullPath, data: { path: fullPath, parsed: taxonomy.parseFileName(path.basename(fullPath)) } };
  },

  'audit-files': (workspace, { values, positionals, io }) => {
    const paths = values.input || values.json || io.stdin
      ? payloadFrom(values, positionals, io)
      : positionals;
    const findings = taxonomy.auditPaths(paths, values.root ? { root: values.root } : undefined);
    const bad = findings.filter(f => !f.ok);
    const text = bad.length === 0
      ? `All ${findings.length} files follow the convention.`
      : bad.map(f => `${f.path}\n    ${f.issue}${f.suggestion ? `\n    → ${f.suggestion}` : ''}`).join('\n');
    return { text, data: findings };
  },

  reconcile(workspace, { values }) {
    const result = finance.reconcile(
      readJson(path.join(workspace, STATEMENTS_FILE), []),
      readJson(path.join(workspace, DOCUMENTS_FILE), []),
      values.window ? { dayWindow: Number(values.window) } : undefined,
    );
    const lines = [
      `Matched ${result.coverage.matchedLines}/${result.coverage.lines} lines `
      + `(${Math.round(result.coverage.byDollars * 100)}% of dollars).`,
      `Unreceipted exposure: ${taxonomy.formatMoney(result.coverage.unreceiptedCents)}.`,
    ];
    for (const row of result.unreceipted) {
      lines.push(`  - ${row.date} ${row.description} ${taxonomy.formatMoney(Math.abs(row.amountCents))}`);
    }
    return { text: lines.join('\n'), data: result };
  },

  'cpa-packet': (workspace, { values }) => {
    const profile = loadProfile(workspace);
    const packet = finance.cpaPacket({
      taxYear: Number(values.year ?? new Date().getFullYear()),
      entity: values.entity ?? profile.entities[0].code,
      documents: readJson(path.join(workspace, DOCUMENTS_FILE), []),
      statementLines: readJson(path.join(workspace, STATEMENTS_FILE), []),
      preparedOn: values.now?.slice(0, 10),
    });
    return { text: renderPacket(packet), data: packet };
  },

  verify(workspace, { values, positionals, io }) {
    const input = payloadFrom(values, positionals, io);
    const claims = (Array.isArray(input) ? input : [input])
      .map(claim => research.verifyClaim(claim, values.now ? { asOf: values.now.slice(0, 10) } : undefined));
    const text = claims.map(c =>
      `[${c.confidence.toUpperCase()}] ${c.claim}\n    ${c.rationale}${c.toSettle ? `\n    To settle: ${c.toSettle}` : ''}`).join('\n');
    return { text, data: claims };
  },

  decide(workspace, { values, positionals, io }) {
    const input = payloadFrom(values, positionals, io);
    const claims = (input.claims ?? []).map(claim =>
      (claim.confidence ? claim : research.verifyClaim(claim, values.now ? { asOf: values.now.slice(0, 10) } : undefined)));
    const result = research.decisionMatrix({ ...input, claims });
    const lines = [
      `Question: ${result.question}`,
      ...result.ranking.map(row => `  ${row.rank}. ${row.id} — ${row.score}`),
      '',
      `Confidence: ${result.confidence}${result.robust ? '' : ' (not weight-proof)'}`,
      `Recommendation: ${result.recommendation}`,
    ];
    return { text: lines.join('\n'), data: result };
  },
};

function financeSnapshot(workspace, values) {
  const documents = readJson(path.join(workspace, DOCUMENTS_FILE), []);
  const statements = readJson(path.join(workspace, STATEMENTS_FILE), []);
  if (documents.length === 0 && statements.length === 0) return null;
  const result = finance.reconcile(statements, documents);
  const gaps = finance.findGaps(documents);
  return {
    unreceiptedCents: result.coverage.unreceiptedCents,
    unreceiptedCount: result.unreceipted.length,
    readiness: Math.round(result.coverage.byDollars * 100),
    note: gaps.length > 0
      ? `${gaps.length} ${gaps.length === 1 ? 'document needs' : 'documents need'} something from you before the file is clean.`
      : null,
    now: values?.now ?? null,
  };
}

function renderPacket(packet) {
  const lines = [
    `# CPA packet — ${packet.entity} ${packet.taxYear}`,
    `Prepared ${packet.preparedOn}. ${packet.scopeNote}`,
    '',
    `Documents: ${packet.documentCount} · Statement lines: ${packet.statementLineCount}`,
    `Business total: ${packet.totals.businessTotal} · Excluded as personal/draw: ${packet.totals.excludedTotal}`,
    `Receipt coverage: ${Math.round(packet.reconciliation.byDollars * 100)}% of dollars · Readiness: ${packet.readiness}%`,
    '',
    '## By category',
    ...packet.byCategory.map(row =>
      `- ${row.label}: ${row.total} (${row.count}) — suggested ${row.scheduleC}`),
  ];
  if (packet.openQuestions.length > 0) {
    lines.push('', `## Open questions (${packet.openQuestions.length})`);
    lines.push(...packet.openQuestions.map(q => `- ${q}`));
  }
  lines.push('', packet.readyToSend
    ? 'Status: ready to send.'
    : 'Status: not ready to send — clear the open questions above first.');
  return lines.join('\n');
}

const OPTIONS = {
  workspace: { type: 'string', short: 'w' },
  input: { type: 'string', short: 'i' },
  json: { type: 'string' },
  now: { type: 'string' },
  at: { type: 'string' },
  actor: { type: 'string' },
  client: { type: 'string' },
  entity: { type: 'string' },
  year: { type: 'string' },
  root: { type: 'string' },
  window: { type: 'string' },
  format: { type: 'string', short: 'f' },
  force: { type: 'boolean', default: false },
  help: { type: 'boolean', short: 'h', default: false },
};

const HELP = `virtual-ea — executive assistant engine

Usage: virtual-ea <command> [options]

Workspace
  init                 Scaffold a client workspace
  readiness            What still has to be answered before the EA can operate

Execution
  add <json>           Log a new commitment
  event <json>         Log an event against one (acknowledged|nudged|escalated|completed|dropped|updated)
  queue                Everything live, most urgent first
  followups            Who needs chasing, and what has stalled
  brief                The daily brief

Judgement
  authority <json>     Check an action against the client's standing authority
  verify <json>        Grade a factual claim against its sources
  decide <json>        Weighted option comparison with a sensitivity check

Records
  file <json>          Canonical filename and folder for a document
  audit-files [paths]  Check an existing archive against the convention
  reconcile            Match statement lines to documents
  cpa-packet           Year-end packet with its own gap list

Options
  -w, --workspace DIR  Client workspace (default: $VIRTUAL_EA_WORKSPACE or .)
  -i, --input FILE     Read JSON payload from a file
      --json TEXT      Inline JSON payload
      --now ISO        Freeze "now" (also makes output reproducible)
  -f, --format json    Emit JSON instead of text
      --help
`;

function run(argv, io = {}) {
  const { values, positionals } = parseArgs({
    args: argv,
    options: OPTIONS,
    allowPositionals: true,
    strict: true,
  });

  const [command, ...rest] = positionals;
  if (values.help || !command) return { text: HELP, data: null };

  const handler = COMMANDS[command];
  if (!handler) {
    throw new UsageError(`unknown command "${command}". Run --help for the list.`);
  }

  const workspace = path.resolve(values.workspace ?? process.env.VIRTUAL_EA_WORKSPACE ?? '.');
  const result = handler(workspace, { values, positionals: rest, io });

  if (values.format === 'json') {
    return { text: JSON.stringify(result.data, null, 2), data: result.data };
  }
  return result;
}

function main() {
  let stdin = '';
  if (!process.stdin.isTTY) {
    try {
      stdin = fs.readFileSync(0, 'utf8');
    } catch {
      stdin = '';
    }
  }
  try {
    const result = run(process.argv.slice(2), { stdin: stdin.trim() || undefined });
    process.stdout.write(`${result.text}\n`);
  } catch (error) {
    // Usage and validation problems are the user's to fix and get a clean
    // message; anything else is a bug in here and keeps its stack.
    if (error instanceof UsageError || error instanceof ledger.LedgerError) {
      process.stderr.write(`error: ${error.message}\n`);
      process.exitCode = 1;
      return;
    }
    throw error;
  }
}

module.exports = { run, UsageError, COMMANDS, HELP };

if (require.main === module) main();
