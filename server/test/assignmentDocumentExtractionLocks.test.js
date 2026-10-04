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
    mutations: [], locks: [], transactions: [] };
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
          if (/SET processing_status = 'uploaded'/.test(sql)) state.document.processing_status = 'uploaded';
          if (/SET processing_status = 'processing'/.test(sql)) {
            state.document.processing_status = 'processing'; state.document.processing_attempts += 1;
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
