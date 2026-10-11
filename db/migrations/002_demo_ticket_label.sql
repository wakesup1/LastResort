-- Translate the existing demo label without resetting inventory or other event data.
UPDATE lastresort.events
SET ticket_type = 'General admission'
WHERE id = 'live-sessions-demo' AND ticket_type = U&'\0E1A\0E31\0E15\0E23\0E17\0E31\0E48\0E27\0E44\0E1B';
