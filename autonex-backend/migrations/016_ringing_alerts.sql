ALTER TABLE push_outbox ADD COLUMN alert_action TEXT NOT NULL DEFAULT 'notify' CHECK(alert_action IN ('notify','ring','stop'));
