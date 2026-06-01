// Stable identifiers mirrored from index.html so tests can reference storage
// keys etc. These are NOT logic — the logic itself is always called live via
// page.evaluate against the real window globals, never re-implemented here.
export const SB_AUTH_KEY = 'sb-xsmnfcmtbpeaccnyinkr-auth-token';
export const API_KEY_KEY = 'anthropic_api_key';
export const HIDDEN_KEY = 'hidden_activities';
export const OFFLINE_CARD_QUEUE_KEY = 'offline_card_queue';
