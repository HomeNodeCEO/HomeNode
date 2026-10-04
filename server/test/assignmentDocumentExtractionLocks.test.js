import assert from 'node:assert/strict';
import test from 'node:test';
import PDFDocument from 'pdfkit';
import { processAssignmentDocument, processPendingAssignmentDocuments, queueAssignmentDocumentExtraction } from '../src/services/assignmentDocuments.js';

async function blankPdf() {
  const pdf = new PDFDocument();
  const chunks = [];
  pdf.on('data', chunk => chunks.push(chunk));
  const finished = new Promise(resolve => pdf.on('end', () => resolve(Buffer.concat(chunks))));
  pdf.end();
  return finished;
}

function fixture({ signed = false, historicalSnapshot = false, native = false, content = null } = {}) {
  const state = { signed, historicalSnapshot, signedSnapshot: Buffer.from('immutable signed snapshot'),
    document: { id: 7, account_id: 'SYNTHETIC', assignment_file_id: native ? null : 9,
      document_type: 'purchase_contract', processing_status: 'reviewed', processing_attempts: 0,
      content, extraction_summary: { unchanged: true } }, pages: ['previous source text'],
    candidates: [{ id: 100, field_key: 'contract_price', normalized_value: '100000.00', review_status: 'confirmed' }],
    mutations: [], locks: [], transactions: [], claimSequence: 0 };
  const pool = {
    async query(sql) {
      if (/CREATE SCHEMA/.test(sql)) return { rows: [] };
      throw new Error(`Untransactional query: ${sql}`);
    },
    async connect() {
      let transaction;
      return { release() {}, async query(sql, values) {
        if (sql === 'BEGIN') { transaction = []; state.transactions.push(transaction); return { rows: [] }; }
        if (sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] };
        if (/SELECT account_id, assignment_file_id/.test(sql)) {
          transaction.push('scope'); return { rows: [{ ...state.document }] };
        }
        if (/SELECT id, file_number FROM app.assignment_files/.test(sql)) {
          transaction.push('assignment'); return { rows: [{ id: 9, file_number: 'QA-TEST' }] };
        }
        if (/INSERT INTO app.custom_appraisal_workfiles/.test(sql)) {
          assert.match(sql, /ON CONFLICT.*DO NOTHING/); return { rows: [] }; // Existing workfile; no mutation.
        }
        if (/SELECT workfile.status/.test(sql)) {
          transaction.push('workfile');
          return { rows: [{ status: state.signed ? 'signed' : 'draft', has_signed_snapshot: state.historicalSnapshot }] };
        }
        if (/SELECT \* FROM app.assignment_documents.*FOR UPDATE/.test(sql)) {
          transaction.push('document'); state.locks.push([...transaction]); return { rows: [{ ...state.document }] };
        }
        if (/AS owns_claim/.test(sql)) {
          assert.equal(transaction.at(-1), 'document', 'claim checks occur after the ordered locks');
          assert.match(sql, /processing_status = 'processing'\s+AND processing_attempts = \$2\s+AND processing_started_at = \$3::timestamptz/);
          const [id, attempt, timestamp] = values;
          return { rows: [{ owns_claim: state.document.id === id
            && state.document.processing_status === 'processing'
            && state.document.processing_attempts === attempt
            && state.document.processing_claim_started_at === timestamp }] };
        }
        if (/SELECT field_key, raw_value/.test(sql)) return { rows: state.candidates.map(candidate => ({ ...candidate })) };
        if (/DELETE FROM app.assignment_document_pages/.test(sql)) {
          state.pages = []; return { rows: [] };
        }
        if (/DELETE FROM app.assignment_document_field_candidates/.test(sql)) {
          state.candidates = []; return { rows: [] };
        }
        if (/INSERT INTO app.assignment_document_pages/.test(sql)) {
          state.pages.push(values[2]); return { rows: [] };
        }
        if (/INSERT INTO app.assignment_document_field_candidates/.test(sql)) {
          const candidate = { id: 101 + state.candidates.length, field_key: values[1], raw_value: values[2],
            normalized_value: values[3], review_status: values[8], confirmed_value: values[9], reviewer: values[10] };
          state.candidates.push(candidate); return { rows: [candidate] };
        }
        if (/UPDATE app.assignment_documents/.test(sql)) {
          if (/document_processing_interrupted_retry_exhausted/.test(sql)) {
            assert.match(sql, /WHERE id = \$1\s+AND processing_status = 'processing'\s+AND processing_attempts >= \$2/);
            assert.match(sql, /COALESCE\(processing_started_at, updated_at\)\s+< now\(\) - \(\$3::integer \* interval '1 minute'\)/);
            const [id, attempts, staleMinutes] = values;
            const started = new Date(state.document.processing_started_at ?? state.document.updated_at).getTime();
            if (state.document.id !== id || state.document.processing_status !== 'processing'
              || state.document.processing_attempts < attempts || !(started < Date.now() - staleMinutes * 60_000)) {
              return { rows: [], rowCount: 0 };
            }
            state.document.processing_status = 'extraction_failed';
          }
          state.mutations.push(sql);
          assert.equal(state.signed || state.historicalSnapshot, false, 'no metadata update after signing');
          if (/SET processing_status = 'uploaded'/.test(sql)) {
            state.document.processing_status = 'uploaded';
            state.document.processing_claim_started_at = null;
          }
          if (/SET processing_status = 'processing'/.test(sql)) {
            assert.match(sql, /RETURNING \*, processing_started_at::text AS processing_claim_started_at/);
            state.document.processing_status = 'processing'; state.document.processing_attempts += 1;
            state.claimSequence += 1;
            state.document.processing_claim_started_at = `2026-01-01 12:00:00.${String(state.claimSequence).padStart(6, '0')}+00`;
            state.document.processing_started_at = new Date('2026-01-01T12:00:00.000Z');
          }
          if (/SET document_type = \$2/.test(sql)) {
            state.document.document_type = values[1];
            state.document.processing_status = values[3];
            state.document.processing_claim_started_at = null;
            state.document.processing_started_at = null;
            state.document.extraction_summary = JSON.parse(values[5]);
          }
          return { rows: [{ ...state.document }] };
        }
        if (/DELETE|INSERT|UPDATE/.test(sql)) throw new Error(`Unexpected evidence write: ${sql}`);
        throw new Error(`Unexpected query: ${sql}`);
      } };
    },
  };
  return { pool, state };
}
const retained = state => JSON.stringify({ document: state.document, pages: state.pages,
  candidates: state.candidates, signedSnapshot: state.signedSnapshot });

for (const type of ['signed status', 'historical snapshot']) {
  for (const operation of ['queue', 'claim']) {
    test(`${operation} refuses ${type} before any document/evidence mutation`, async () => {
      const { pool, state } = fixture({ signed: type === 'signed status', historicalSnapshot: type === 'historical snapshot' });
      const before = retained(state);
      await assert.rejects(operation === 'queue' ? queueAssignmentDocumentExtraction(pool, 7)
        : processAssignmentDocument(pool, 7, { force: true }), /custom_appraisal_workfile_signed/);
      assert.equal(retained(state), before);
      assert.deepEqual(state.mutations, []);
      assert.deepEqual(state.transactions, [['scope', 'assignment', 'workfile']]);
    });
  }
}

test('signing after enqueue blocks the subsequent claim without mutating its durable queue entry', async () => {
  const { pool, state } = fixture();
  await queueAssignmentDocumentExtraction(pool, 7);
  state.signed = true;
  const before = retained(state), mutationCount = state.mutations.length;
  await assert.rejects(processAssignmentDocument(pool, 7), /custom_appraisal_workfile_signed/);
  assert.equal(retained(state), before);
  assert.equal(state.mutations.length, mutationCount);
  assert.deepEqual(state.locks, [['scope', 'assignment', 'workfile', 'document']]);
});

for (const [outcome, guard] of ['success', 'busy', 'failure'].flatMap(outcome =>
  ['signed', 'historicalSnapshot'].map(guard => [outcome, guard]))) {
  test(`${guard} during OCR ${outcome} blocks writeback, retry and failure metadata`, async () => {
    const { pool, state } = fixture({ content: await blankPdf() });
    let atSigning;
    const provider = { configured: true, async analyzePdf() {
      state[guard] = true;
      atSigning = retained(state);
      if (outcome !== 'success') throw new Error(outcome === 'busy' ? 'document_ocr_busy' : 'document_ocr_failed');
      return { pages: ['Synthetic recovered contract text for review, with no proposed fields.'] };
    } };
    await assert.rejects(processAssignmentDocument(pool, 7, { force: true, ocrProvider: provider, logger: { warn() {} } }),
      /custom_appraisal_workfile_signed/);
    assert.ok(atSigning);
    assert.equal(retained(state), atSigning);
    assert.equal(state.mutations.length, 1, 'only the claim preceding signing changed metadata');
    assert.match(state.mutations[0], /SET processing_status = 'processing'/);
    assert.deepEqual(state.locks, [['scope', 'assignment', 'workfile', 'document']]);
  });
}

test('native documents without a Custom assignment retain queue support and do not create a Custom workfile', async () => {
  const { pool, state } = fixture({ native: true });
  assert.equal((await queueAssignmentDocumentExtraction(pool, 7)).processing_status, 'uploaded');
  assert.deepEqual(state.locks, [['scope', 'document']]);
});

for (const outcome of ['success', 'busy', 'failure']) {
  test(`late attempt N ${outcome} preserves attempt N+1's completed pages and subsequent reviews`, async () => {
    const { pool, state } = fixture({ content: await blankPdf() });
    const logs = [];
    let afterNewerReview, newerMutationCount;
    const newerProvider = { configured: true, async analyzePdf() {
      return { pages: ['Newer recovered source text. Keep this newly extracted page.'] };
    } };
    const olderProvider = { configured: true, async analyzePdf() {
      await processAssignmentDocument(pool, 7, { force: true, ocrProvider: newerProvider });
      assert.equal(state.document.processing_attempts, 2);
      assert.match(state.pages[0], /Newer recovered source text/);
      // A reviewer can confirm the newer extraction before the old scanner finishes.
      state.document.processing_status = 'reviewed';
      state.candidates = [{ id: 202, field_key: 'contract_price', normalized_value: '150000.00',
        review_status: 'confirmed', confirmed_value: '150000.00', reviewer: 'Synthetic Reviewer' }];
      afterNewerReview = retained(state);
      newerMutationCount = state.mutations.length;
      if (outcome !== 'success') throw new Error(outcome === 'busy' ? 'document_ocr_busy' : 'document_ocr_failed');
      return { pages: ['Obsolete attempt N page. This must never replace the newer page.'] };
    } };
    const result = await processAssignmentDocument(pool, 7, {
      force: true, ocrProvider: olderProvider, logger: { warn: (...args) => logs.push(args) },
    });
    assert.equal(result.processing_status, 'reviewed');
    assert.equal(result.processing_attempts, 2);
    assert.equal(retained(state), afterNewerReview);
    assert.equal(state.mutations.length, newerMutationCount);
    assert.deepEqual(logs, []);
    assert.equal(state.locks.length, 4, 'both claims and both completions use ordered locks');
    for (const locks of state.locks) assert.deepEqual(locks, ['scope', 'assignment', 'workfile', 'document']);
  });

  for (const replacement of ['newer processing attempt', 'same-attempt microsecond reclaim', 'manual queue reset']) {
    test(`late ${outcome} leaves ${replacement} untouched`, async () => {
      const { pool, state } = fixture({ content: await blankPdf() });
      let newerState;
      const logs = [];
      const provider = { configured: true, async analyzePdf() {
        const oldTimestamp = state.document.processing_claim_started_at;
        if (replacement === 'manual queue reset') {
          await queueAssignmentDocumentExtraction(pool, 7);
          state.document.processing_attempts = 0;
          state.document.processing_started_at = null;
        } else {
          if (replacement === 'newer processing attempt') state.document.processing_attempts += 1;
          state.document.processing_claim_started_at = '2026-01-01 12:00:00.000002+00';
          // The two DB timestamps differ although the pg Date values are identical.
          assert.equal(new Date(oldTimestamp).getTime(), new Date(state.document.processing_claim_started_at).getTime());
          assert.notEqual(oldTimestamp, state.document.processing_claim_started_at);
        }
        newerState = retained(state);
        if (outcome !== 'success') throw new Error(outcome === 'busy' ? 'document_ocr_busy' : 'document_ocr_failed');
        return { pages: ['Outdated recovered source text.'] };
      } };
      const result = await processAssignmentDocument(pool, 7, {
        force: true, ocrProvider: provider, logger: { warn: (...args) => logs.push(args) },
      });
      assert.equal(result.processing_status, replacement === 'manual queue reset' ? 'uploaded' : 'processing');
      assert.equal(retained(state), newerState);
      assert.equal(state.mutations.length, replacement === 'manual queue reset' ? 2 : 1);
      assert.deepEqual(logs, []);
    });
  }
}

test('maintenance excludes signed status and historical snapshots without rewriting frozen queue states', async () => {
  const queries = [];
  const pool = { async query(sql) {
    if (/CREATE SCHEMA/.test(sql)) return { rows: [] };
    queries.push(sql);
    assert.match(sql, /NOT EXISTS \(SELECT 1 FROM app.custom_appraisal_workfiles/);
    assert.match(sql, /workfile.status = 'signed'/);
    assert.match(sql, /NOT EXISTS \(SELECT 1 FROM app.custom_appraisal_signed_snapshots/);
    return { rows: [] };
  } };
  assert.deepEqual(await processPendingAssignmentDocuments(pool), { attempted: 0, results: [] });
  assert.equal(queries.length, 2);
  assert.match(queries[1], /WHERE \(\(processing_status = 'uploaded'/);
});

function exhaustedFixture(afterSelection = () => {}) {
  const fixtureState = fixture();
  const { pool, state } = fixtureState;
  state.document.processing_status = 'processing';
  state.document.processing_attempts = 3;
  state.document.processing_started_at = new Date(Date.now() - 60 * 60_000).toISOString();
  const schemaQuery = pool.query;
  pool.query = async (sql, values) => {
    if (/CREATE SCHEMA/.test(sql)) return schemaQuery(sql, values);
    assert.match(sql, /^SELECT id/);
    if (/processing_attempts >= \$1/.test(sql)) {
      assert.match(sql, /ORDER BY uploaded_at\s+LIMIT \$3/);
      assert.equal(values[2], 50, 'maintenance cleanup has the same bounded batch limit');
      afterSelection(state);
      return { rows: [{ id: 7 }] };
    }
    return { rows: [] };
  };
  return fixtureState;
}

for (const guard of ['signed', 'historicalSnapshot']) {
  test(`exhausted maintenance skips ${guard} added after selection without any frozen metadata write`, async () => {
    let atSigning;
    const { pool, state } = exhaustedFixture(state => {
      state[guard] = true;
      atSigning = retained(state);
    });
    assert.deepEqual(await processPendingAssignmentDocuments(pool, { limit: 1000, maximumAttempts: 3 }),
      { attempted: 0, results: [] });
    assert.equal(retained(state), atSigning);
    assert.deepEqual(state.mutations, []);
    assert.deepEqual(state.transactions, [['scope', 'assignment', 'workfile']]);
  });
}

for (const [changed, patch] of [
  ['status', { processing_status: 'reviewed' }],
  ['attempt count', { processing_attempts: 0 }],
  ['processing start', { processing_started_at: '9999-01-01T00:00:00.000Z' }],
]) {
  test(`exhausted maintenance rechecks ${changed} after taking workfile and document locks`, async () => {
    let afterSelection;
    const { pool, state } = exhaustedFixture(state => {
      Object.assign(state.document, patch);
      afterSelection = retained(state);
    });
    assert.deepEqual(await processPendingAssignmentDocuments(pool, { limit: 1000, maximumAttempts: 3 }),
      { attempted: 0, results: [] });
    assert.equal(retained(state), afterSelection);
    assert.deepEqual(state.mutations, []);
    assert.deepEqual(state.locks, [['scope', 'assignment', 'workfile', 'document']]);
  });
}

test('exhausted maintenance marks a still-mutable stale document failed under ordered locks', async () => {
  const { pool, state } = exhaustedFixture();
  assert.deepEqual(await processPendingAssignmentDocuments(pool, { limit: 1000, maximumAttempts: 3 }),
    { attempted: 0, results: [] });
  assert.equal(state.document.processing_status, 'extraction_failed');
  assert.equal(state.mutations.length, 1);
  assert.deepEqual(state.locks, [['scope', 'assignment', 'workfile', 'document']]);
});
