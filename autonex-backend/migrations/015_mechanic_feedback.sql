CREATE TABLE mechanic_response_events (
 id SERIAL PRIMARY KEY,
 request_id INTEGER NOT NULL REFERENCES repair_requests(id),
 direct_attempt INTEGER NOT NULL,
 driver_id INTEGER NOT NULL REFERENCES users(id),
 mechanic_id INTEGER NOT NULL REFERENCES users(id),
 decision TEXT NOT NULL CHECK(decision IN ('accept','decline')),
 created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(request_id,direct_attempt)
);
CREATE INDEX mechanic_response_recent ON mechanic_response_events(mechanic_id,created_at);
CREATE TABLE verified_mechanic_feedback (
 journey_id INTEGER PRIMARY KEY REFERENCES journeys(id),
 driver_id INTEGER NOT NULL REFERENCES users(id),
 mechanic_id INTEGER NOT NULL REFERENCES users(id),
 stars INTEGER NOT NULL CHECK(stars BETWEEN 1 AND 5),
 comment TEXT NOT NULL DEFAULT '',
 created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX verified_feedback_mechanic ON verified_mechanic_feedback(mechanic_id);
