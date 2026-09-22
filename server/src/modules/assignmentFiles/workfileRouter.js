import express from "express";

import { createAssignmentWorkfileItemRouter } from "./workfileItemRouter.js";
import { createAssignmentWorkfileMutationRouter } from "./workfileMutationRouter.js";
import { createAssignmentWorkfileReadRouter } from "./workfileReadRouter.js";

export function createAssignmentWorkfileRouter({
  pool,
  ensureCustomAppraisalWorkfilesAvailable,
  requireWorkflowAccess,
  requireEditor,
  requireAssignmentAccess,
  authenticationRequired,
  sharedObjectStorage,
  uadObjectStorage,
} = {}) {
  const router = express.Router();
  router.use(createAssignmentWorkfileReadRouter({
    pool,
    ensureCustomAppraisalWorkfilesAvailable,
    requireWorkflowAccess,
    requireAssignmentAccess,
    objectStorage: sharedObjectStorage,
  }));
  router.use(createAssignmentWorkfileMutationRouter({
    pool,
    ensureCustomAppraisalWorkfilesAvailable,
    requireEditor,
    requireAssignmentAccess,
    authenticationRequired,
    objectStorage: sharedObjectStorage,
  }));
  router.use(createAssignmentWorkfileItemRouter({
    pool,
    sharedObjectStorage,
    uadObjectStorage,
    requireWorkflowAccess,
    requireAssignmentAccess,
  }));
  return router;
}
