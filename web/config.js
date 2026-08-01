/* Quay 1 Boarding Tool - frontend config (LIVE).
 *
 * Safe to commit and serve publicly, exactly like quay-hubspot/config.js: the
 * Supabase anon key is public by design (every table is gated by Postgres RLS)
 * and auth is PIN-based via a synthetic <username>@quay1.local email, so staff
 * use the same login across all Quay 1 tools.
 *
 * LIFECYCLE_ENDPOINT points at the deployed consolidated Apps Script backend
 * (blocker B1 cleared). A health GET to the /exec URL returns "ok". If it is
 * ever re-blanked, login + browsing still work but any submit shows
 * "endpoint not set"; after a re-deploy, paste the new /exec URL here and re-push.
 */
window.QUAY_CFG = Object.freeze({
  // Supabase project "quay-clock" (PRODUCTION) - same as quay-hubspot/quay-leads/quay-clock.
  SUPABASE_URL: 'https://dqszbqiimbfvmmnpgpsb.supabase.co',
  SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRxc3picWlpbWJmdm1tbnBncHNiIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA4NDk4OTQsImV4cCI6MjA5NjQyNTg5NH0.M9RQnJEidyIMZAwbELTSPakiSnvuWBdHTjD7nuOdCZY',
  // Synthetic email domain used internally for PIN-based auth.
  AUTH_EMAIL_DOMAIN: 'quay1.local',

  // Consolidated Apps Script web app /exec URL (deployed as pagan@quay1.co.za,
  // executeAs USER_DEPLOYING, access ANYONE_ANONYMOUS). Health ping returns "ok".
  LIFECYCLE_ENDPOINT: 'https://script.google.com/macros/s/AKfycbxxz6URW_jE1hiREWXCIQLrwulOaYOmm0DPHAnMGZRpRexxFK1juqurV97mxT8oNK3Y/exec',
});
