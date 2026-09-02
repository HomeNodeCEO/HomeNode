const INITIALIZATION_CODE = /^[a-z0-9_]{1,80}$/;

function assertCode(value) {
  const code = String(value || "");
  if (!INITIALIZATION_CODE.test(code)) {
    throw new TypeError("startup_initialization_code_invalid");
  }
  return code;
}

function groupSnapshot(entries, required) {
  const matching = entries.filter((entry) => entry.required === required);
  return Object.freeze({
    ready: Object.freeze(matching.filter((entry) => entry.state === "ready").map((entry) => entry.code)),
    pending: Object.freeze(matching.filter((entry) => entry.state === "pending").map((entry) => entry.code)),
    failed: Object.freeze(matching.filter((entry) => entry.state === "failed").map((entry) => entry.code)),
  });
}

export function createStartupInitializationRegistry() {
  const entries = new Map();

  function track(codeValue, operation, { required = true } = {}) {
    const code = assertCode(codeValue);
    if (typeof operation !== "function") {
      throw new TypeError("startup_initialization_operation_required");
    }
    if (entries.has(code)) {
      throw new Error("startup_initialization_code_duplicate");
    }
    const entry = { code, required: Boolean(required), state: "pending" };
    entries.set(code, entry);
    return Promise.resolve()
      .then(operation)
      .then((value) => {
        entry.state = "ready";
        return value;
      }, (error) => {
        entry.state = "failed";
        throw error;
      });
  }

  function snapshot() {
    const values = [...entries.values()];
    const required = groupSnapshot(values, true);
    const optional = groupSnapshot(values, false);
    const status = required.failed.length > 0
      ? "failed"
      : required.pending.length > 0
        ? "pending"
        : optional.failed.length > 0 || optional.pending.length > 0
          ? "degraded"
          : "ready";
    return Object.freeze({ status, required, optional });
  }

  return Object.freeze({ track, snapshot });
}
