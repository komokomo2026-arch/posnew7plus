/* drive-client.js — shared by POS (index.html) and Finance (Finance.html).
 *
 * The browser no longer talks to Google Drive directly and no longer holds any Drive configuration.
 * Every Drive call is POSTed to the SAME Google Apps Script Web App URL used for subscriptions
 * (SUBSCRIPTION_API_URL in index.html). Apps Script decides — on the server — whether this Device ID has an
 * active PAID subscription, and only then performs the Drive call. Free-trial, expired and unknown devices are rejected there.
 *
 * Nothing secret is stored here: the browser only ever receives (a) a short-lived signed session, and
 * (b) the public OAuth client ID, and both are issued only to eligible paid devices.
 */
(function () {
  'use strict';
  var TRIAL_MSG = 'Subscribe now to unlock Google Drive connection and backup. Renew your subscription to protect your data.';
  var EXPIRED_MSG = 'Your subscription has expired. Renew your subscription to use Google Drive connection and backup.';
  var SUB_KEY = 'ekambani_pos_sub_state_v2', ID_KEY = 'ekambani_pos_device_id_v1', URL_KEY = 'ekambani_api_url';
  var sess = null, sessPromise = null, handler = null, lastToastAt = 0;

  function deviceId() {
    var id = '';
    try { id = String(window.EKAMBANI_DEVICE_ID || ''); } catch (e) {}
    if (!id) { try { id = String(window.parent && window.parent.EKAMBANI_DEVICE_ID || ''); } catch (e) {} }
    if (!id) { try { id = localStorage.getItem(ID_KEY) || ''; } catch (e) {} }
    return id.trim();
  }
  function apiUrl() {
    var u = '';
    try { u = String(window.SUBSCRIPTION_API_URL || ''); } catch (e) {}
    if (!/^https:\/\/script\.google\.com\/macros\/s\/[^/]+\/exec$/i.test(u)) { try { u = localStorage.getItem(URL_KEY) || ''; } catch (e) { u = ''; } }
    return /^https:\/\/script\.google\.com\/macros\/s\/[^/]+\/exec$/i.test(u) ? u : '';
  }
  function ymd(d) { var p = function (n) { return ('0' + n).slice(-2); }; return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()); }
  /* Local hint only (to disable buttons and avoid pointless requests). The server is the final authority. */
  function localState() {
    try {
      var o = JSON.parse(localStorage.getItem(SUB_KEY) || 'null');
      if (!o || o.deviceId !== deviceId()) return { allowed: false, code: 'UNVERIFIED' };
      var now = Math.max(Date.now(), Number(o.maxSeen) || 0), today = ymd(new Date(now));
      if (!o.startDate || !o.endDate || o.startDate === o.endDate || o.endDate < today) return { allowed: false, code: 'SUBSCRIPTION_EXPIRED' };
      if (o.plan === 'trial') return { allowed: false, code: 'TRIAL' };
      return { allowed: true, code: '' };
    } catch (e) { return { allowed: false, code: 'UNVERIFIED' }; }
  }
  function messageFor(code, serverMsg) {
    if (code === 'TRIAL') return TRIAL_MSG;
    if (code === 'SUBSCRIPTION_EXPIRED') return EXPIRED_MSG;
    if (code === 'UNVERIFIED' || code === 'DEVICE_UNKNOWN' || code === 'DEVICE_INVALID') return TRIAL_MSG;
    return serverMsg || TRIAL_MSG;
  }
  function blockedError(code, msg) {
    var e = new Error(messageFor(code, msg)); e.notEligible = true; e.code = code; e.needsAuth = false; return e;
  }
  /* Shows the notice once per few seconds. Pages may set their own toast through EkbDrive.setNotifier(fn). */
  function notify(msg) {
    var now = Date.now(); if (now - lastToastAt < 2500) return; lastToastAt = now;
    if (handler) { try { handler(msg); return; } catch (e) {} }
    var t = document.getElementById('ekbDriveToast');
    if (!t) {
      t = document.createElement('div'); t.id = 'ekbDriveToast'; t.setAttribute('role', 'status');
      t.style.cssText = 'position:fixed;left:50%;bottom:24px;transform:translateX(-50%);max-width:92%;background:#0f172a;color:#fff;padding:11px 16px;border-radius:10px;font:13px/1.4 Arial,sans-serif;z-index:2147483600;box-shadow:0 6px 20px #0004;text-align:center';
      document.body.appendChild(t);
    }
    t.textContent = msg; t.style.display = 'block'; clearTimeout(t._h); t._h = setTimeout(function () { t.style.display = 'none'; }, 6000);
  }
  async function post(body, timeoutMs) {
    var url = apiUrl();
    if (!url) throw new Error('Google Drive backup is not available: the subscription server address is not set.');
    body.deviceId = deviceId();
    var ctl = (typeof AbortController !== 'undefined') ? new AbortController() : null, to = ctl ? setTimeout(function () { ctl.abort(); }, timeoutMs || 90000) : 0, r;
    try {
      r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(body), redirect: 'follow', credentials: 'omit', signal: ctl ? ctl.signal : undefined });
    } catch (err) { var ne = new Error('Network problem. Check your internet connection.'); ne.network = true; throw ne; }
    finally { if (to) clearTimeout(to); }
    var j; try { j = await r.json(); } catch (err) { var pe = new Error('The backup server sent an unreadable reply. Try again later.'); pe.status = 502; throw pe; }
    return j;
  }
  /* Server check only. Never returns configuration. */
  async function eligibility() {
    var j = await post({ op: 'eligibility' }, 20000);
    return j && j.allowed ? { allowed: true, plan: j.plan, remainingDays: j.remainingDays } : { allowed: false, code: (j && j.code) || 'UNVERIFIED', message: messageFor(j && j.code, j && j.message) };
  }
  /* Starts (or reuses) a signed Drive session. Only paid, active devices receive one. */
  async function session(force) {
    if (!force && sess && Date.now() < sess.expiresAt - 60000) return sess;
    if (sessPromise) return sessPromise;
    sessPromise = (async function () {
      var j = await post({ op: 'session' }, 30000);
      if (!j || !j.allowed || !j.session) { sess = null; throw blockedError(j && j.code, j && j.message); }
      sess = { token: j.session, expiresAt: Number(j.expiresAt) || (Date.now() + 15 * 60000), config: j.config || {} };
      return sess;
    })();
    try { return await sessPromise; } finally { sessPromise = null; }
  }
  /* Same shape as fetch(): resolves to a Response with Google's own status and body. Blocked devices get an Error with notEligible = true. */
  async function driveFetch(url, opts, accessToken) {
    var local = localState();
    if (!local.allowed && (local.code === 'TRIAL' || local.code === 'SUBSCRIPTION_EXPIRED')) throw blockedError(local.code);
    opts = opts || {};
    var s = await session(false), j;
    var req = function () {
      var h = opts.headers || {};
      return post({ op: 'drive', session: sess.token, accessToken: accessToken, method: (opts.method || 'GET').toUpperCase(), url: url, contentType: h['Content-Type'] || h['content-type'] || '', body: opts.body === undefined ? undefined : String(opts.body) });
    };
    j = await req();
    if (j && j.code === 'SESSION_INVALID') { await session(true); j = await req(); }
    if (!j || !j.allowed) throw blockedError(j && j.code, j && j.message);
    if (j.ok === false) { var ee = new Error(j.message || 'Google Drive request refused.'); ee.status = j.status || 401; ee.needsAuth = j.code === 'NEEDS_AUTH'; throw ee; }
    var st = Number(j.status) || 500, nobody = st === 204 || st === 205 || st === 304;
    return new Response(nobody ? null : (j.body == null ? '' : String(j.body)), { status: st });
  }
  window.EkbDrive = {
    deviceId: deviceId, apiUrl: apiUrl, localState: localState, eligibility: eligibility, session: session, fetch: driveFetch,
    notify: notify, setNotifier: function (fn) { handler = fn; }, messageFor: messageFor, TRIAL_MESSAGE: TRIAL_MSG, EXPIRED_MESSAGE: EXPIRED_MSG,
    clearSession: function () { sess = null; }
  };
  try { var u = apiUrl(); if (u) localStorage.setItem(URL_KEY, u); } catch (e) {}
})();
