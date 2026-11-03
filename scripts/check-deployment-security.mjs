import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

// This probe creates one guest session on the named host. It never books or resets data.
const [origin, foreignReference, confirm] = process.argv.slice(2);
if (!origin || !foreignReference || confirm !== "--create-guest-session" ||
    !/^https:\/\/[^/]+$/.test(origin) ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(foreignReference)) {
  console.error("Provide a canonical HTTPS origin, another owner's reservation UUID, and --create-guest-session.");
  process.exit(1);
}
try {
  const parsed = new URL(origin);
  if (parsed.origin !== origin || parsed.username || parsed.password) throw new Error();
} catch {
  console.error("Origin must be a canonical HTTPS origin without credentials.");
  process.exit(1);
}
const request = (path, options = {}) => fetch(origin + path, { redirect: 'manual', signal: AbortSignal.timeout(20000), ...options });
const noStore = (response) => assert.match(response.headers.get('cache-control') ?? '', /no-store/i);
const noCors = (response) => assert.equal(response.headers.get('access-control-allow-origin'), null);
const check = (label) => console.log(`PASS ${label}`);

try {
  const health = await request('/api/health');
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), {status:'ok',database:'ready'});
  noStore(health); check('HTTPS health and no-store');

  const crossSession = await request('/api/session', {method:'POST', headers:{origin:'https://attacker.example'}});
  assert.equal(crossSession.status, 403); assert.equal(crossSession.headers.get('set-cookie'), null); noStore(crossSession); noCors(crossSession);
  const crossBooking = await request('/api/reservations', {method:'POST', headers:{origin:'https://attacker.example','content-type':'application/json','idempotency-key':randomUUID()}, body:JSON.stringify({eventId:'live-sessions-demo',quantity:1})});
  assert.equal(crossBooking.status, 403); noStore(crossBooking); noCors(crossBooking); check('cross-origin session and booking rejected');

  const session = await request('/api/session', {method:'POST',headers:{origin}});
  assert.equal(session.status, 204); noStore(session); noCors(session);
  const setCookie = session.headers.get('set-cookie'); assert.ok(setCookie);
  assert.match(setCookie, /^lastresort_guest=[A-Za-z0-9_-]{43};/);
  for (const attr of [/;\s*Secure(?:;|$)/i,/;\s*HttpOnly(?:;|$)/i,/;\s*SameSite=Lax(?:;|$)/i,/;\s*Path=\/(?:;|$)/i,/;\s*Max-Age=2592000(?:;|$)/i]) assert.match(setCookie,attr);
  assert.doesNotMatch(setCookie,/;\s*Domain=/i);
  const cookie = setCookie.split(';')[0]; check('guest cookie protections');
  const token = cookie.slice(cookie.indexOf('=') + 1);
  const noToken = async (response) => assert.ok(!(await response.clone().text()).includes(token));

  const resume = await request('/api/session',{method:'POST',headers:{origin,cookie}});
  assert.equal(resume.status,204); assert.equal(resume.headers.get('set-cookie'),null); check('session resumes without replacement cookie');
  const forged = await request('/api/reservations', {method:'POST', headers:{origin,cookie,'content-type':'application/json','idempotency-key':randomUUID()},body:JSON.stringify({eventId:`s3-05-nonexistent-${randomUUID()}`,quantity:1,ownerId:randomUUID()})});
  assert.equal(forged.status,400); noStore(forged); await noToken(forged); check('forged owner payload rejected');
  const spoofed = await request('/api/session', {method:'POST',headers:{origin:'https://attacker.example','x-forwarded-host':'attacker.example','x-forwarded-proto':'https'}});
  assert.equal(spoofed.status,403); assert.equal(spoofed.headers.get('set-cookie'),null); check('forwarded origin spoof rejected');
  const history = await request('/api/reservations',{headers:{cookie,origin:'https://attacker.example'}});
  assert.equal(history.status,200); noStore(history); noCors(history);
  await noToken(history); const body = await history.json(); assert.ok(Array.isArray(body.reservations)); assert.equal(body.reservations.length,0); check('fresh guest sees empty private history');

  const foreign = await request('/api/reservations/'+foreignReference,{headers:{cookie}});
  const unknown = await request('/api/reservations/'+randomUUID(),{headers:{cookie}});
  assert.equal(foreign.status,404); assert.equal(unknown.status,404); noStore(foreign); noStore(unknown); noCors(foreign);
  await noToken(foreign); await noToken(unknown); assert.deepEqual(await foreign.json(),await unknown.json()); check('other owner reference is indistinguishable from unknown');
  const unauth = await request('/api/reservations/'+foreignReference);
  assert.equal(unauth.status,401); noStore(unauth); check('reference without session denied');
  const operation = await request('/api/booking-operations/'+randomUUID(),{headers:{cookie,origin:'https://attacker.example'}});
  assert.equal(operation.status,404); noStore(operation); noCors(operation); await noToken(operation); check('operation read is private and no-store');

  const preflight = await request('/api/reservations',{method:'OPTIONS',headers:{origin:'https://attacker.example','access-control-request-method':'POST','access-control-request-headers':'content-type,idempotency-key'}});
  noCors(preflight); check('cross-origin preflight does not grant browser access');
  const http = await fetch(origin.replace(/^https:/, 'http:') + '/api/health',{redirect:'manual',signal:AbortSignal.timeout(20000)});
  assert.ok([301,302,307,308].includes(http.status)); assert.equal(new URL(http.headers.get('location')).origin,origin); check('HTTP redirects to canonical HTTPS');
} catch (error) {
  console.error('FAIL: a security check failed or the service was unavailable; no response contents are printed.');
  process.exitCode = 1;
}
