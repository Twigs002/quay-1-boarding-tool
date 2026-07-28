/* Quay 1 Boarding Tool - frontend config.
 *
 * Copy this file to web/config.js and fill in the values. config.js is
 * gitignored; NEVER commit it. The Supabase anon key is public (all tables are
 * gated by Postgres RLS) so it is safe on a static host, but we keep it out of
 * source control so the endpoint URL and keys live in one deployed-only place.
 *
 * Same Supabase project as quay-clock / quay-leads / quay-hubspot, so staff
 * sign in with the same username + PIN they use everywhere else.
 */
window.QUAY_CFG = Object.freeze({
  // Supabase project "quay-clock" (PRODUCTION, id dqszbqiimbfvmmnpgpsb).
  SUPABASE_URL: 'https://YOUR_PROJECT.supabase.co',
  SUPABASE_ANON_KEY: 'YOUR_SUPABASE_ANON_KEY',
  // Synthetic email domain used internally for PIN-based auth.
  AUTH_EMAIL_DOMAIN: 'quay1.local',

  // Consolidated Apps Script web app (doGet/doPost router). All reads + writes
  // POST here with Content-Type text/plain to dodge the CORS preflight.
  LIFECYCLE_ENDPOINT: 'https://script.google.com/macros/s/YOUR_DEPLOYMENT_ID/exec',
});
