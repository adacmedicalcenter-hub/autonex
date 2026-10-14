ALTER TABLE repair_requests ADD COLUMN audio_note TEXT;
ALTER TABLE repair_requests ADD COLUMN audio_duration INTEGER;
ALTER TABLE quotes ADD COLUMN audio_note TEXT;
ALTER TABLE quotes ADD COLUMN audio_duration INTEGER;
ALTER TABLE messages ADD COLUMN audio_note TEXT;
ALTER TABLE messages ADD COLUMN audio_duration INTEGER;
