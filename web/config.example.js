/* Quay 1 Boarding Tool - frontend config.
 *
 * Copy this file to web/config.js and fill in the values. config.js IS
 * committed (like quay-hubspot/config.js) so it ships to the GitHub Pages site:
 * the Supabase anon key is public by design (all tables are gated by Postgres
 * RLS) and the /exec URL is not a secret, so both are safe on a static host.
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
