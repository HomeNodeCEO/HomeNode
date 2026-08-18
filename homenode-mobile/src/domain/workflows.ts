export const WORKFLOWS = [
  {
    type: "custom_appraisal",
    title: "Custom Appraisal",
    description: "HomeNode custom appraisal workflow",
  },
  {
    type: "uad_3_6",
    title: "UAD 3.6 Appraisal",
    description: "UAD 3.6 inspection and workfile",
  },
  {
    type: "property_tax_protest",
    title: "Property Tax Protest",
    description: "Independent property-tax protest file",
  },
] as const;

export type WorkflowType = typeof WORKFLOWS[number]["type"];

export function workflowTitle(type: WorkflowType) {
  return WORKFLOWS.find((workflow) => workflow.type === type)?.title ?? type;
}
