-- Executed transactionally by lib/postgres-storage.mjs in the configured TSS schema.
-- JSONB preserves existing workflow/approval fields while generated columns support
-- relational constraints and indexed queries. Every business entity has its own row.

CREATE TABLE metadata (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object')
);

CREATE TABLE users (
  id text PRIMARY KEY,
  ordinal bigint NOT NULL CHECK (ordinal >= 0),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object' AND payload ? 'id' AND payload->>'id' = id),
  username text GENERATED ALWAYS AS (payload->>'username') STORED NOT NULL UNIQUE,
  role text GENERATED ALWAYS AS (payload->>'role') STORED NOT NULL,
  active boolean GENERATED ALWAYS AS ((payload->>'active')::boolean) STORED NOT NULL,
  version bigint GENERATED ALWAYS AS ((payload->>'version')::bigint) STORED NOT NULL CHECK (version > 0)
);

CREATE TABLE customers (
  id text PRIMARY KEY,
  ordinal bigint NOT NULL CHECK (ordinal >= 0),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object' AND payload ? 'id' AND payload->>'id' = id),
  name text GENERATED ALWAYS AS (payload->>'name') STORED NOT NULL,
  tax_id text GENERATED ALWAYS AS (nullif(payload->>'taxId', '')) STORED,
  owner_id text GENERATED ALWAYS AS (nullif(payload->>'ownerId', '')) STORED,
  credit_limit_cents bigint GENERATED ALWAYS AS ((payload->>'creditLimitCents')::bigint) STORED NOT NULL CHECK (credit_limit_cents >= 0),
  version bigint GENERATED ALWAYS AS ((payload->>'version')::bigint) STORED NOT NULL CHECK (version > 0),
  CONSTRAINT customers_owner_fk FOREIGN KEY (owner_id) REFERENCES users(id) DEFERRABLE INITIALLY DEFERRED
);
CREATE UNIQUE INDEX customers_tax_id_unique ON customers(tax_id) WHERE tax_id IS NOT NULL;
CREATE INDEX customers_name_idx ON customers(lower(name));
CREATE INDEX customers_owner_idx ON customers(owner_id);

CREATE TABLE quotes (
  id text PRIMARY KEY,
  ordinal bigint NOT NULL CHECK (ordinal >= 0),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object' AND payload ? 'id' AND payload->>'id' = id),
  reference text GENERATED ALWAYS AS (payload->>'reference') STORED NOT NULL UNIQUE,
  customer_id text GENERATED ALWAYS AS (payload->>'customerId') STORED NOT NULL,
  job_id text GENERATED ALWAYS AS (nullif(payload->>'jobId', '')) STORED UNIQUE,
  status text GENERATED ALWAYS AS (payload->>'status') STORED NOT NULL,
  price_cents bigint GENERATED ALWAYS AS ((payload->>'priceCents')::bigint) STORED NOT NULL CHECK (price_cents > 0),
  version bigint GENERATED ALWAYS AS ((payload->>'version')::bigint) STORED NOT NULL CHECK (version > 0),
  CONSTRAINT quotes_customer_fk FOREIGN KEY (customer_id) REFERENCES customers(id) DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX quotes_customer_idx ON quotes(customer_id);
CREATE INDEX quotes_status_idx ON quotes(status);

CREATE TABLE jobs (
  id text PRIMARY KEY,
  ordinal bigint NOT NULL CHECK (ordinal >= 0),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object' AND payload ? 'id' AND payload->>'id' = id),
  reference text GENERATED ALWAYS AS (payload->>'reference') STORED NOT NULL UNIQUE,
  customer_id text GENERATED ALWAYS AS (payload->>'customerId') STORED NOT NULL,
  quote_id text GENERATED ALWAYS AS (nullif(payload->>'quoteId', '')) STORED UNIQUE,
  driver_user_id text GENERATED ALWAYS AS (nullif(payload->>'driverUserId', '')) STORED,
  vehicle text GENERATED ALWAYS AS (payload->>'vehicle') STORED,
  status text GENERATED ALWAYS AS (payload->>'status') STORED NOT NULL,
  pickup_date text GENERATED ALWAYS AS (payload->>'pickupDate') STORED NOT NULL,
  delivery_date text GENERATED ALWAYS AS (payload->>'deliveryDate') STORED NOT NULL,
  price_cents bigint GENERATED ALWAYS AS ((payload->>'priceCents')::bigint) STORED NOT NULL CHECK (price_cents >= 0),
  version bigint GENERATED ALWAYS AS ((payload->>'version')::bigint) STORED NOT NULL CHECK (version > 0),
  CONSTRAINT jobs_customer_fk FOREIGN KEY (customer_id) REFERENCES customers(id) DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT jobs_quote_fk FOREIGN KEY (quote_id) REFERENCES quotes(id) DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT jobs_driver_fk FOREIGN KEY (driver_user_id) REFERENCES users(id) DEFERRABLE INITIALLY DEFERRED
);
ALTER TABLE quotes ADD CONSTRAINT quotes_job_fk FOREIGN KEY (job_id) REFERENCES jobs(id) DEFERRABLE INITIALLY DEFERRED;
CREATE INDEX jobs_customer_idx ON jobs(customer_id);
CREATE INDEX jobs_status_dates_idx ON jobs(status, pickup_date, delivery_date);
CREATE INDEX jobs_driver_dates_idx ON jobs(driver_user_id, pickup_date, delivery_date);
CREATE INDEX jobs_vehicle_dates_idx ON jobs(vehicle, pickup_date, delivery_date);

CREATE TABLE yard (
  id text PRIMARY KEY,
  ordinal bigint NOT NULL CHECK (ordinal >= 0),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object' AND payload ? 'id' AND payload->>'id' = id),
  job_id text GENERATED ALWAYS AS (payload->>'jobId') STORED NOT NULL,
  vehicle text GENERATED ALWAYS AS (payload->>'vehicle') STORED NOT NULL,
  location text GENERATED ALWAYS AS (payload->>'location') STORED NOT NULL,
  checked_out_at text GENERATED ALWAYS AS (payload->>'checkedOutAt') STORED,
  version bigint GENERATED ALWAYS AS ((payload->>'version')::bigint) STORED NOT NULL CHECK (version > 0),
  CONSTRAINT yard_job_fk FOREIGN KEY (job_id) REFERENCES jobs(id) DEFERRABLE INITIALLY DEFERRED
);
CREATE UNIQUE INDEX yard_active_vehicle_unique ON yard(vehicle) WHERE checked_out_at IS NULL;
CREATE UNIQUE INDEX yard_active_location_unique ON yard(lower(location)) WHERE checked_out_at IS NULL;
CREATE INDEX yard_job_idx ON yard(job_id);

CREATE TABLE work_orders (
  id text PRIMARY KEY,
  ordinal bigint NOT NULL CHECK (ordinal >= 0),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object' AND payload ? 'id' AND payload->>'id' = id),
  reference text GENERATED ALWAYS AS (payload->>'reference') STORED NOT NULL UNIQUE,
  vehicle text GENERATED ALWAYS AS (payload->>'vehicle') STORED NOT NULL,
  status text GENERATED ALWAYS AS (payload->>'status') STORED NOT NULL,
  estimated_cost_cents bigint GENERATED ALWAYS AS ((payload->>'estimatedCostCents')::bigint) STORED NOT NULL CHECK (estimated_cost_cents >= 0),
  actual_cost_cents bigint GENERATED ALWAYS AS ((payload->>'actualCostCents')::bigint) STORED CHECK (actual_cost_cents >= 0),
  version bigint GENERATED ALWAYS AS ((payload->>'version')::bigint) STORED NOT NULL CHECK (version > 0)
);
CREATE INDEX work_orders_vehicle_status_idx ON work_orders(vehicle, status);

CREATE TABLE invoices (
  id text PRIMARY KEY,
  ordinal bigint NOT NULL CHECK (ordinal >= 0),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object' AND payload ? 'id' AND payload->>'id' = id),
  reference text GENERATED ALWAYS AS (payload->>'reference') STORED NOT NULL UNIQUE,
  job_id text GENERATED ALWAYS AS (payload->>'jobId') STORED NOT NULL UNIQUE,
  customer_id text GENERATED ALWAYS AS (payload->>'customerId') STORED NOT NULL,
  status text GENERATED ALWAYS AS (payload->>'status') STORED NOT NULL,
  due_date text GENERATED ALWAYS AS (payload->>'dueDate') STORED NOT NULL,
  amount_cents bigint GENERATED ALWAYS AS ((payload->>'amountCents')::bigint) STORED NOT NULL CHECK (amount_cents > 0),
  version bigint GENERATED ALWAYS AS ((payload->>'version')::bigint) STORED NOT NULL CHECK (version > 0),
  CONSTRAINT invoices_job_fk FOREIGN KEY (job_id) REFERENCES jobs(id) DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT invoices_customer_fk FOREIGN KEY (customer_id) REFERENCES customers(id) DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX invoices_customer_idx ON invoices(customer_id);
CREATE INDEX invoices_status_due_idx ON invoices(status, due_date);

CREATE TABLE audit (
  id text PRIMARY KEY,
  ordinal bigint NOT NULL CHECK (ordinal >= 0),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object' AND payload ? 'id' AND payload->>'id' = id),
  event text GENERATED ALWAYS AS (payload->>'event') STORED NOT NULL,
  at text GENERATED ALWAYS AS (payload->>'at') STORED NOT NULL,
  actor_id text GENERATED ALWAYS AS (payload->>'actorId') STORED,
  entity_type text GENERATED ALWAYS AS (payload->>'entityType') STORED,
  entity_id text GENERATED ALWAYS AS (payload->>'entityId') STORED
);
CREATE INDEX audit_at_idx ON audit(at DESC);
CREATE INDEX audit_entity_idx ON audit(entity_type, entity_id, at DESC);
CREATE INDEX audit_actor_idx ON audit(actor_id, at DESC);

-- Stable original collection order is needed for exact import verification and
-- for append-only audit display. Queries use (ordinal, id) as their ordering.
CREATE INDEX users_ordinal_idx ON users(ordinal, id);
CREATE INDEX customers_ordinal_idx ON customers(ordinal, id);
CREATE INDEX jobs_ordinal_idx ON jobs(ordinal, id);
CREATE INDEX quotes_ordinal_idx ON quotes(ordinal, id);
CREATE INDEX yard_ordinal_idx ON yard(ordinal, id);
CREATE INDEX work_orders_ordinal_idx ON work_orders(ordinal, id);
CREATE INDEX invoices_ordinal_idx ON invoices(ordinal, id);
CREATE INDEX audit_ordinal_idx ON audit(ordinal, id);
