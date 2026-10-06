import express from 'express';
import { resolveCanonicalAccountId } from '../../services/accountQuality.js';
import { logBoundedFailure, knownErrorCode } from '../../security/boundedRouteErrors.js';
import { sfrepTransferInput, readSfrepDocuments, previewSfrepDocuments, packageSfrepDocuments } from '../../services/sfrepDocumentTransfer.js';
import { readSfrepPhotos, addSfrepPhotoViewUrls } from '../../services/sfrepPhotoTransfer.js';

const CLIENT_ERRORS = new Set(['invalid_sfrep_request', 'assignment_file_required', 'invalid_sfrep_document_selection',
  'sfrep_preview_required', 'sfrep_document_not_found', 'sfrep_evidence_limit', 'sfrep_document_integrity_failed',
  'sfrep_package_too_large', 'sfrep_preview_changed', 'account_not_found',
  'sfrep_photo_integrity_failed', 'sfrep_photo_storage_unavailable']);

export function createSfrepDocumentRouter({ pool, objectStorage, ensureAvailable, requireWorkflowAccess, requireAssignmentAccess,
  resolveAccountId = resolveCanonicalAccountId, readDocuments = readSfrepDocuments, readPhotos = readSfrepPhotos,
  buildPreview = previewSfrepDocuments,
  buildPackage = packageSfrepDocuments, logger = console } = {}) {
  if (!pool || typeof pool.query !== 'function' || [ensureAvailable, requireWorkflowAccess, requireAssignmentAccess,
    resolveAccountId, readDocuments, readPhotos, buildPreview, buildPackage].some(value => typeof value !== 'function')) {
    throw new TypeError('sfrep_router_dependencies_required');
  }
  const router = express.Router();
  // Bound package buffers per server process; a duplicate click must not consume
  // another large buffer for the same file. The outer application limiter still applies.
  const activeExports = new Set();
  for (const action of ['preview', 'export']) {
    router.post(`/api/accounts/:id/sfrep/${action}`, async (req, res) => {
      res.set('cache-control', 'no-store');
      if (!req.mobileAuth) return res.status(401).json({ error: 'authentication_required' });
      if (!requireWorkflowAccess(req, res, 'custom_appraisal', 'read')) return;
      let exportKey;
      const controller = new AbortController();
      let timeout;
      let cleanedUp = false;
      const cleanup = () => {
        if (cleanedUp) return;
        cleanedUp = true;
        if (exportKey) activeExports.delete(exportKey);
        clearTimeout(timeout);
        res.removeListener('close', close);
        res.removeListener('finish', cleanup);
      };
      const close = () => { controller.abort(); cleanup(); };
      try {
        const input = sfrepTransferInput(req.body, { exporting: action === 'export' });
        await ensureAvailable();
        input.accountId = await resolveAccountId(pool, String(req.params.id || '').trim());
        if (!await requireAssignmentAccess(req, res, input.accountId, input.assignmentFileId, 'read')) return;
        if (action === 'export') {
          const key = `${input.accountId}:${input.assignmentFileId}`;
          if (activeExports.has(key) || activeExports.size >= 2) return res.set('retry-after', '5').status(429).json({ error: 'sfrep_export_busy' });
          exportKey = key;
          activeExports.add(key);
        }
        res.once('close', close);
        res.once('finish', cleanup);
        // A disconnect during readiness/authorization predates these listeners.
        if (res.destroyed) { close(); return; }
        timeout = setTimeout(() => {
          controller.abort();
          // Once download headers have been sent, JSON cannot report a timeout.
          // Close a stalled response so its queued package buffer is released.
          if (res.headersSent && !res.writableFinished && !res.destroyed) res.destroy();
        }, 60_000);
        const documents = await readDocuments(pool, input);
        controller.signal.throwIfAborted();
        const photos = await readPhotos(pool, input);
        controller.signal.throwIfAborted();
        const preview = buildPreview(documents, input, photos);
        if (action === 'preview') {
          const { reportXml: _xml, pdfAddenda: _pdfs, imageAddenda: _images, ...publicPreview } = preview;
          return res.json({ ok: true, ...publicPreview,
            photos: addSfrepPhotoViewUrls(preview.photos || [], preview.imageAddenda || [], objectStorage) });
        }
        const result = await buildPackage(pool, objectStorage, documents, preview, input, { signal: controller.signal });
        controller.signal.throwIfAborted();
        return res.set('content-type', 'application/octet-stream')
          .set('content-disposition', `attachment; filename="${preview.filename}"`)
          .send(result.content);
      } catch (error) {
        const code = knownErrorCode(error, CLIENT_ERRORS);
        const status = code === 'sfrep_document_not_found' || code === 'account_not_found' ? 404
          : code === 'sfrep_preview_changed' || code === 'sfrep_document_integrity_failed' || code === 'sfrep_photo_integrity_failed' ? 409
          : code === 'sfrep_photo_storage_unavailable' ? 503
          : code === 'sfrep_package_too_large' || code === 'sfrep_evidence_limit' ? 413 : 400;
        if (code) return res.status(status).json({ error: code });
        logBoundedFailure(logger, 'SFREP document transfer failed', error);
        if (!res.destroyed) return res.status(controller.signal.aborted ? 504 : 500).json({ error: 'sfrep_transfer_failed' });
      } finally {
        // res.send() can return with bytes still queued for a slow client. Keep
        // the slot and deadline until finish/close, not merely until packaging.
        if (!res.headersSent || res.writableFinished || res.destroyed) cleanup();
      }
    });
  }
  return router;
}
