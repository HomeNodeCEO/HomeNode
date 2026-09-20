/**
 * Creates an identity-closed plan gate. A structurally identical copy is not an
 * approved plan: only the exact frozen objects installed by the owning module
 * can cross the execution boundary.
 */
export function createClosedSqlPlanGate(installedPlans,reject) {
  if (!installedPlans || Object.getPrototypeOf(installedPlans)!==Object.prototype
    || typeof reject!=='function') throw new TypeError('invalid_closed_sql_plan_gate');
  const descriptors=Object.getOwnPropertyDescriptors(installedPlans);
  const entries=Object.entries(descriptors).map(([key,descriptor]) => {
    const plan=descriptor.value;
    if (!Object.hasOwn(descriptor,'value') || !plan || typeof plan!=='object' || !Object.isFrozen(plan)) {
      throw new TypeError('invalid_closed_sql_plan_gate');
    }
    return [key,plan];
  });
  const plans=Object.freeze(Object.fromEntries(entries));
  const accepted=new WeakSet(Object.values(plans));
  return Object.freeze({plans,assert(plan) {
    if (!plan || typeof plan!=='object' || !accepted.has(plan)) return reject();
    return plan;
  }});
}
