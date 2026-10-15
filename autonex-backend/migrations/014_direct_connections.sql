ALTER TABLE repair_requests ADD COLUMN target_mechanic_id INTEGER REFERENCES users(id);
ALTER TABLE repair_requests ADD COLUMN connection_stage TEXT CHECK(connection_stage IN ('ping','describe','offer','offered','searching','connected'));
ALTER TABLE repair_requests ADD COLUMN search_radius_m INTEGER NOT NULL DEFAULT 5000 CHECK(search_radius_m IN (5000,10000,20000,50000));
ALTER TABLE repair_requests ADD COLUMN client_reference TEXT;
CREATE UNIQUE INDEX direct_connection_retry ON repair_requests(driver_id,client_reference) WHERE client_reference IS NOT NULL;
CREATE UNIQUE INDEX one_direct_search_per_driver ON repair_requests(driver_id) WHERE connection_stage IS NOT NULL AND status='open';
ALTER TABLE quotes ADD COLUMN displacement_fee_xaf INTEGER CHECK(displacement_fee_xaf>=0);
ALTER TABLE repair_requests ADD COLUMN direct_attempt INTEGER NOT NULL DEFAULT 1;
