-- Automatic collection still requires fresh accurate GPS dwell at the locked destination.
INSERT INTO admin_config(config_key,config_value) VALUES('automatic_gps_arrival','true') ON CONFLICT(config_key) DO UPDATE SET config_value='true';
