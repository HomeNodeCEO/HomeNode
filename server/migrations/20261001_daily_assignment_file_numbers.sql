CREATE TABLE IF NOT EXISTS app.report_file_daily_counters (
  organization_id uuid NOT NULL REFERENCES app_auth.organizations(id) ON DELETE CASCADE,
  assignment_date date NOT NULL,
  next_value bigint NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, assignment_date),
  CHECK (assignment_date >= DATE '2000-01-01' AND assignment_date < DATE '2201-01-01'),
  CHECK (next_value >= 1)
);

COMMENT ON TABLE app.report_file_daily_counters IS
  'Atomic organization-wide daily sequence used for YYYY-DDD-NN appraisal file numbers across workflows.';
