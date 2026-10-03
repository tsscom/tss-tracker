-- Additive operational modules; existing tables and credentials are untouched.
CREATE TABLE vehicles (
  id text PRIMARY KEY, ordinal bigint NOT NULL CHECK (ordinal >= 0),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object' AND payload ? 'id' AND payload->>'id' = id),
  registration text GENERATED ALWAYS AS (payload->>'registration') STORED NOT NULL UNIQUE,
  status text GENERATED ALWAYS AS (payload->>'status') STORED NOT NULL,
  inspection_due_date text GENERATED ALWAYS AS (payload->>'inspectionDueDate') STORED,
  insurance_due_date text GENERATED ALWAYS AS (payload->>'insuranceDueDate') STORED,
  next_service_date text GENERATED ALWAYS AS (payload->>'nextServiceDate') STORED,
  version bigint GENERATED ALWAYS AS ((payload->>'version')::bigint) STORED NOT NULL CHECK (version > 0)
);
CREATE INDEX vehicles_status_idx ON vehicles(status);
CREATE INDEX vehicles_inspection_idx ON vehicles(inspection_due_date);
CREATE INDEX vehicles_insurance_idx ON vehicles(insurance_due_date);
CREATE INDEX vehicles_service_idx ON vehicles(next_service_date);

CREATE TABLE drivers (
  id text PRIMARY KEY, ordinal bigint NOT NULL CHECK (ordinal >= 0),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object' AND payload ? 'id' AND payload->>'id' = id),
  user_id text GENERATED ALWAYS AS (nullif(payload->>'userId', '')) STORED UNIQUE,
  name text GENERATED ALWAYS AS (payload->>'name') STORED NOT NULL,
  status text GENERATED ALWAYS AS (payload->>'status') STORED NOT NULL,
  license_expiry_date text GENERATED ALWAYS AS (payload->>'licenseExpiryDate') STORED,
  version bigint GENERATED ALWAYS AS ((payload->>'version')::bigint) STORED NOT NULL CHECK (version > 0),
  CONSTRAINT drivers_user_fk FOREIGN KEY (user_id) REFERENCES users(id) DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX drivers_status_idx ON drivers(status);
CREATE INDEX drivers_license_idx ON drivers(license_expiry_date);

CREATE TABLE opportunities (
  id text PRIMARY KEY, ordinal bigint NOT NULL CHECK (ordinal >= 0),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object' AND payload ? 'id' AND payload->>'id' = id),
  customer_id text GENERATED ALWAYS AS (payload->>'customerId') STORED NOT NULL,
  owner_id text GENERATED ALWAYS AS (nullif(payload->>'ownerId', '')) STORED,
  status text GENERATED ALWAYS AS (payload->>'status') STORED NOT NULL,
  follow_up_date text GENERATED ALWAYS AS (payload->>'nextFollowUpDate') STORED,
  expected_value_cents bigint GENERATED ALWAYS AS ((payload->>'expectedValueCents')::bigint) STORED NOT NULL CHECK (expected_value_cents >= 0),
  version bigint GENERATED ALWAYS AS ((payload->>'version')::bigint) STORED NOT NULL CHECK (version > 0),
  CONSTRAINT opportunities_customer_fk FOREIGN KEY (customer_id) REFERENCES customers(id) DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT opportunities_owner_fk FOREIGN KEY (owner_id) REFERENCES users(id) DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX opportunities_customer_idx ON opportunities(customer_id);
CREATE INDEX opportunities_follow_up_idx ON opportunities(status, follow_up_date);

CREATE TABLE activities (
  id text PRIMARY KEY, ordinal bigint NOT NULL CHECK (ordinal >= 0),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object' AND payload ? 'id' AND payload->>'id' = id),
  opportunity_id text GENERATED ALWAYS AS (payload->>'opportunityId') STORED NOT NULL,
  customer_id text GENERATED ALWAYS AS (payload->>'customerId') STORED NOT NULL,
  due_date text GENERATED ALWAYS AS (payload->>'dueDate') STORED,
  completed_at text GENERATED ALWAYS AS (payload->>'completedAt') STORED,
  version bigint GENERATED ALWAYS AS ((payload->>'version')::bigint) STORED NOT NULL CHECK (version > 0),
  CONSTRAINT activities_opportunity_fk FOREIGN KEY (opportunity_id) REFERENCES opportunities(id) DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT activities_customer_fk FOREIGN KEY (customer_id) REFERENCES customers(id) DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX activities_opportunity_idx ON activities(opportunity_id);
CREATE INDEX activities_due_idx ON activities(due_date) WHERE completed_at IS NULL;

CREATE TABLE incidents (
  id text PRIMARY KEY, ordinal bigint NOT NULL CHECK (ordinal >= 0),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object' AND payload ? 'id' AND payload->>'id' = id),
  job_id text GENERATED ALWAYS AS (payload->>'jobId') STORED NOT NULL,
  type text GENERATED ALWAYS AS (payload->>'type') STORED NOT NULL,
  severity text GENERATED ALWAYS AS (payload->>'severity') STORED NOT NULL,
  status text GENERATED ALWAYS AS (payload->>'status') STORED NOT NULL,
  version bigint GENERATED ALWAYS AS ((payload->>'version')::bigint) STORED NOT NULL CHECK (version > 0),
  CONSTRAINT incidents_job_fk FOREIGN KEY (job_id) REFERENCES jobs(id) DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX incidents_job_idx ON incidents(job_id);
CREATE INDEX incidents_status_severity_idx ON incidents(status, severity);

CREATE TABLE costs (
  id text PRIMARY KEY, ordinal bigint NOT NULL CHECK (ordinal >= 0),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object' AND payload ? 'id' AND payload->>'id' = id),
  job_id text GENERATED ALWAYS AS (payload->>'jobId') STORED NOT NULL,
  category text GENERATED ALWAYS AS (payload->>'category') STORED NOT NULL,
  reference text GENERATED ALWAYS AS (payload->>'reference') STORED NOT NULL,
  supplier text GENERATED ALWAYS AS (payload->>'supplier') STORED NOT NULL,
  amount_cents bigint GENERATED ALWAYS AS ((payload->>'amountCents')::bigint) STORED NOT NULL CHECK (amount_cents > 0),
  cost_date text GENERATED ALWAYS AS (payload->>'date') STORED NOT NULL,
  version bigint GENERATED ALWAYS AS ((payload->>'version')::bigint) STORED NOT NULL CHECK (version > 0),
  CONSTRAINT costs_job_fk FOREIGN KEY (job_id) REFERENCES jobs(id) DEFERRABLE INITIALLY DEFERRED
);
CREATE UNIQUE INDEX costs_supplier_reference_unique ON costs(lower(supplier), lower(reference), category);
CREATE INDEX costs_job_idx ON costs(job_id);
CREATE INDEX costs_date_idx ON costs(cost_date);

CREATE TABLE attachments (
  id text PRIMARY KEY, ordinal bigint NOT NULL CHECK (ordinal >= 0),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object' AND payload ? 'id' AND payload->>'id' = id),
  job_id text GENERATED ALWAYS AS (payload->>'jobId') STORED NOT NULL,
  created_by text GENERATED ALWAYS AS (payload->>'createdBy') STORED NOT NULL,
  kind text GENERATED ALWAYS AS (payload->>'kind') STORED NOT NULL,
  storage_key text GENERATED ALWAYS AS (payload->>'storageKey') STORED NOT NULL,
  size_bytes bigint GENERATED ALWAYS AS ((payload->>'sizeBytes')::bigint) STORED NOT NULL CHECK (size_bytes > 0),
  sha256 text GENERATED ALWAYS AS (payload->>'sha256') STORED NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  version bigint GENERATED ALWAYS AS ((payload->>'version')::bigint) STORED NOT NULL CHECK (version > 0),
  CONSTRAINT attachments_job_fk FOREIGN KEY (job_id) REFERENCES jobs(id) DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT attachments_creator_fk FOREIGN KEY (created_by) REFERENCES users(id) DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX attachments_job_kind_idx ON attachments(job_id, kind);
CREATE INDEX attachments_storage_key_idx ON attachments(storage_key);

CREATE TABLE mobile_operations (
  id text PRIMARY KEY, ordinal bigint NOT NULL CHECK (ordinal >= 0),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object' AND payload ? 'id' AND payload->>'id' = id),
  user_id text GENERATED ALWAYS AS (payload->>'userId') STORED NOT NULL,
  operation_id text GENERATED ALWAYS AS (payload->>'operationId') STORED NOT NULL,
  version bigint GENERATED ALWAYS AS ((payload->>'version')::bigint) STORED NOT NULL CHECK (version > 0),
  CONSTRAINT mobile_operations_user_fk FOREIGN KEY (user_id) REFERENCES users(id) DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT mobile_operations_user_operation_unique UNIQUE (user_id, operation_id)
);

CREATE INDEX vehicles_ordinal_idx ON vehicles(ordinal, id);
CREATE INDEX drivers_ordinal_idx ON drivers(ordinal, id);
CREATE INDEX opportunities_ordinal_idx ON opportunities(ordinal, id);
CREATE INDEX activities_ordinal_idx ON activities(ordinal, id);
CREATE INDEX incidents_ordinal_idx ON incidents(ordinal, id);
CREATE INDEX costs_ordinal_idx ON costs(ordinal, id);
CREATE INDEX attachments_ordinal_idx ON attachments(ordinal, id);
CREATE INDEX mobile_operations_ordinal_idx ON mobile_operations(ordinal, id);

-- A version-1 repository preserved unknown top-level JSON fields in metadata.
-- Move any pre-existing operational arrays into their new tables before removing
-- only those array keys; this also preserves records imported before this upgrade.
INSERT INTO vehicles(id, ordinal, payload) SELECT item->>'id', position - 1, item FROM metadata, jsonb_array_elements(coalesce(payload->'vehicles', '[]'::jsonb)) WITH ORDINALITY AS rows(item, position);
INSERT INTO drivers(id, ordinal, payload) SELECT item->>'id', position - 1, item FROM metadata, jsonb_array_elements(coalesce(payload->'drivers', '[]'::jsonb)) WITH ORDINALITY AS rows(item, position);
INSERT INTO opportunities(id, ordinal, payload) SELECT item->>'id', position - 1, item FROM metadata, jsonb_array_elements(coalesce(payload->'opportunities', '[]'::jsonb)) WITH ORDINALITY AS rows(item, position);
INSERT INTO activities(id, ordinal, payload) SELECT item->>'id', position - 1, item FROM metadata, jsonb_array_elements(coalesce(payload->'activities', '[]'::jsonb)) WITH ORDINALITY AS rows(item, position);
INSERT INTO incidents(id, ordinal, payload) SELECT item->>'id', position - 1, item FROM metadata, jsonb_array_elements(coalesce(payload->'incidents', '[]'::jsonb)) WITH ORDINALITY AS rows(item, position);
INSERT INTO costs(id, ordinal, payload) SELECT item->>'id', position - 1, item FROM metadata, jsonb_array_elements(coalesce(payload->'costs', '[]'::jsonb)) WITH ORDINALITY AS rows(item, position);
INSERT INTO attachments(id, ordinal, payload) SELECT item->>'id', position - 1, item FROM metadata, jsonb_array_elements(coalesce(payload->'attachments', '[]'::jsonb)) WITH ORDINALITY AS rows(item, position);
INSERT INTO mobile_operations(id, ordinal, payload) SELECT item->>'id', position - 1, item FROM metadata, jsonb_array_elements(coalesce(payload->'mobileOperations', '[]'::jsonb)) WITH ORDINALITY AS rows(item, position);
UPDATE metadata SET payload = payload - 'vehicles' - 'drivers' - 'opportunities' - 'activities' - 'incidents' - 'costs' - 'attachments' - 'mobileOperations';

ALTER TABLE jobs ADD COLUMN vehicle_id text GENERATED ALWAYS AS (nullif(payload->>'vehicleId', '')) STORED;
ALTER TABLE jobs ADD COLUMN driver_id text GENERATED ALWAYS AS (nullif(payload->>'driverId', '')) STORED;
ALTER TABLE jobs ADD CONSTRAINT jobs_vehicle_registry_fk FOREIGN KEY (vehicle_id) REFERENCES vehicles(id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE jobs ADD CONSTRAINT jobs_driver_registry_fk FOREIGN KEY (driver_id) REFERENCES drivers(id) DEFERRABLE INITIALLY DEFERRED;
CREATE INDEX jobs_vehicle_registry_idx ON jobs(vehicle_id);
CREATE INDEX jobs_driver_registry_idx ON jobs(driver_id);
