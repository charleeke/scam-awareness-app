/* =========================================================
   Cloudflare Worker — Anthropic API proxy + ระบบบันทึกผลการเรียนรู้
   ---------------------------------------------------------
   เส้นทาง (route) ทั้งหมด:
     POST /  หรือ /api/chat   ส่งต่อไป Anthropic (เติม API key ฝั่งเซิร์ฟเวอร์)
     GET  /api/config         บอกหน้าเว็บว่าเปิดการเก็บข้อมูลอยู่หรือไม่
     POST /api/log            รับข้อมูลการเล่น 1 รอบ (เฉพาะผู้ที่กดยินยอม)
     GET  /api/admin/data     ข้อมูลสำหรับ dashboard      (ต้องมี ADMIN_TOKEN)
     GET  /api/admin/transcript?id=...  บทสนทนาในสาย    (ต้องมี ADMIN_TOKEN)
     POST /api/admin/delete   ลบ session (เช่น ข้อมูลทดสอบ) (ต้องมี ADMIN_TOKEN)

   ค่าที่ต้องตั้งใน Worker → Settings → Variables and Secrets / Bindings:
     ANTHROPIC_API_KEY   (Secret)  คีย์จริงจาก console.anthropic.com
     ALLOWED_ORIGIN      (Text)    https://charleeke.github.io
     ADMIN_TOKEN         (Secret)  รหัสเข้า dashboard (สุ่มยาว ≥ 32 ตัวอักษร)
     TRACKING_ENABLED    (Text)    "1" = เปิดเก็บข้อมูล  — ตั้งหลังได้รับ
                                   อนุมัติจริยธรรมการวิจัยในมนุษย์แล้วเท่านั้น
                                   (ไม่ตั้ง/ค่าอื่น = ปิด แอปทำงานแบบเดิมทุกอย่าง)
     STUDENT_ID_PATTERN  (Text, ไม่บังคับ) regex ตรวจรูปแบบรหัส นศ.
                                   ค่าเริ่มต้น ^[0-9]{5,12}$
     DB                  (D1 binding) ผูกกับฐานข้อมูล scam_awareness_db

   ขั้นตอนตั้งค่าแบบละเอียดอยู่ใน SETUP_TRACKING.md

   หมายเหตุด้านความปลอดภัย: Worker เป็น public endpoint การเช็ค Origin
   กันได้ระดับหนึ่งแต่ปลอมได้ — ตัวป้องกันหลักของ API key คือ spending
   limit, ของข้อมูลคือ ADMIN_TOKEN (ไม่มี token = อ่านข้อมูลไม่ได้เลย)
   ========================================================= */

var DEFAULT_ID_PATTERN = '^[0-9]{5,12}$';
var MAX_LOG_BYTES = 48 * 1024;
var MAX_ADMIN_ROWS = 5000;

export default {
  async fetch(request, env) {
    var url = new URL(request.url);
    var path = url.pathname.replace(/\/+$/, '') || '/';
    var origin = request.headers.get('Origin') || '';

    var cors = {
      'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN || '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'content-type, authorization',
      'Access-Control-Max-Age': '86400',
      'Vary': 'Origin'
    };

    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });
    if (env.ALLOWED_ORIGIN && origin !== env.ALLOWED_ORIGIN) {
      return text('Forbidden', 403, cors);
    }

    try {
      if (path === '/' || path === '/api/chat') {
        if (request.method !== 'POST') return text('Method not allowed', 405, cors);
        return await proxyAnthropic(request, env, cors);
      }
      if (path === '/api/config' && request.method === 'GET') {
        return json({
          tracking: trackingOn(env),
          studentIdPattern: env.STUDENT_ID_PATTERN || DEFAULT_ID_PATTERN
        }, 200, cors);
      }
      if (path === '/api/log' && request.method === 'POST') {
        return await handleLog(request, env, cors);
      }
      if (path.indexOf('/api/admin/') === 0) {
        if (!(await isAdmin(request, env))) return json({ error: 'unauthorized' }, 401, cors);
        if (!env.DB) return json({ error: 'D1 binding "DB" is missing' }, 500, cors);
        if (path === '/api/admin/data' && request.method === 'GET') return await adminData(url, env, cors);
        if (path === '/api/admin/transcript' && request.method === 'GET') return await adminTranscript(url, env, cors);
        if (path === '/api/admin/delete' && request.method === 'POST') return await adminDelete(request, env, cors);
      }
      return text('Not found', 404, cors);
    } catch (e) {
      return json({ error: 'server_error', detail: String(e && e.message || e) }, 500, cors);
    }
  }
};

/* ---------------- helpers ---------------- */
function text(body, status, cors) {
  return new Response(body, { status: status, headers: cors });
}
function json(obj, status, cors) {
  return new Response(JSON.stringify(obj), {
    status: status,
    headers: Object.assign({ 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }, cors)
  });
}
function trackingOn(env) {
  return env.TRACKING_ENABLED === '1' && !!env.DB;
}
function intIn(v, min, max) {
  if (v === null || v === undefined || v === '') return null;
  var n = Math.round(Number(v));
  if (!isFinite(n)) return null;
  return Math.min(max, Math.max(min, n));
}
function strMax(v, max) {
  if (v === null || v === undefined) return null;
  var s = String(v).trim();
  return s ? s.slice(0, max) : null;
}
function oneOf(v, list) {
  return list.indexOf(v) !== -1 ? v : null;
}

/* ---------------- Anthropic proxy (เหมือนเดิม) ---------------- */
async function proxyAnthropic(request, env, cors) {
  if (!env.ANTHROPIC_API_KEY) return text('Server missing ANTHROPIC_API_KEY', 500, cors);
  var bodyText;
  try { bodyText = await request.text(); } catch (e) { return text('Bad request', 400, cors); }
  var upstream = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: bodyText
  });
  var respBody = await upstream.text();
  return new Response(respBody, {
    status: upstream.status,
    headers: Object.assign({ 'content-type': 'application/json' }, cors)
  });
}

/* ---------------- POST /api/log ---------------- */
var HOUR = 3600 * 1000;
async function handleLog(request, env, cors) {
  if (!trackingOn(env)) return json({ ok: false, reason: 'tracking_disabled' }, 403, cors);

  if (env.LOG_LIMITER) { // ไม่บังคับ: Workers Rate Limiting binding
    var ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    var rl = await env.LOG_LIMITER.limit({ key: ip });
    if (!rl.success) return json({ ok: false, reason: 'rate_limited' }, 429, cors);
  }

  var raw = await request.text(); // รับทั้ง application/json และ text/plain (sendBeacon)
  if (raw.length > MAX_LOG_BYTES) return json({ ok: false, reason: 'too_large' }, 413, cors);
  var body;
  try { body = JSON.parse(raw); } catch (e) { return json({ ok: false, reason: 'bad_json' }, 400, cors); }
  var s = body && body.session;
  if (!s || typeof s !== 'object') return json({ ok: false, reason: 'no_session' }, 400, cors);

  var id = String(s.id || '');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    return json({ ok: false, reason: 'bad_id' }, 400, cors);
  }
  // ไม่มีความยินยอม = ไม่บันทึก (บังคับที่ฝั่งเซิร์ฟเวอร์ด้วย ไม่ใช่แค่หน้าเว็บ)
  var consent = strMax(s.consent_version, 16);
  if (!consent) return json({ ok: false, reason: 'no_consent' }, 400, cors);
  var studentId = strMax(s.student_id, 20);
  var pattern;
  try { pattern = new RegExp(env.STUDENT_ID_PATTERN || DEFAULT_ID_PATTERN); }
  catch (e) { pattern = new RegExp(DEFAULT_ID_PATTERN); }
  if (!studentId || !pattern.test(studentId)) return json({ ok: false, reason: 'bad_student_id' }, 400, cors);

  var row = {
    student_id: studentId,
    class_code: strMax(s.class_code, 40),
    consent_version: consent,
    device: oneOf(s.device, ['ios', 'android', 'desktop']),
    browser: oneOf(s.browser, ['safari', 'chrome', 'other']),
    status: oneOf(s.status, ['in_progress', 'completed']) || 'in_progress',
    last_screen: strMax(s.last_screen, 30),
    lesson_ms: intIn(s.lesson_ms, 0, 2 * HOUR),
    quiz_active_ms: intIn(s.quiz_active_ms, 0, 2 * HOUR),
    score: intIn(s.score, 0, 50),
    total: intIn(s.total, 0, 50),
    call_trigger_q: intIn(s.call_trigger_q, 0, 50),
    call_forced: intIn(s.call_forced, 0, 1),
    ring_ms: intIn(s.ring_ms, 0, HOUR),
    call_outcome: oneOf(s.call_outcome, ['declined', 'missed', 'hungup', 'transferred']),
    call_duration_ms: intIn(s.call_duration_ms, 0, 2 * HOUR),
    call_turns: intIn(s.call_turns, 0, 200),
    call_end_reason: oneOf(s.call_end_reason, ['user', 'mic_error', 'no_speech', 'ai_error']),
    mic_error: strMax(s.mic_error, 40)
  };
  var cols = Object.keys(row);
  var now = Date.now();
  var sql =
    'INSERT INTO sessions (id, created_at, updated_at, ' + cols.join(', ') + ') ' +
    'VALUES (?, ?, ?, ' + cols.map(function () { return '?'; }).join(', ') + ') ' +
    'ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at, ' +
    cols.map(function (c) {
      if (c === 'status') return "status = CASE WHEN sessions.status = 'completed' THEN 'completed' ELSE excluded.status END";
      return c + ' = COALESCE(excluded.' + c + ', sessions.' + c + ')';
    }).join(', ');
  var stmts = [env.DB.prepare(sql).bind(id, now, now, ...cols.map(function (c) { return row[c]; }))];

  var answers = Array.isArray(body.answers) ? body.answers.slice(0, 50) : [];
  answers.forEach(function (a) {
    var q = intIn(a && a.q_index, 0, 49);
    if (q === null) return;
    stmts.push(env.DB.prepare(
      'INSERT OR REPLACE INTO answers (session_id, q_index, selected, correct, time_ms) VALUES (?, ?, ?, ?, ?)'
    ).bind(id, q, intIn(a.selected, 0, 20), intIn(a.correct, 0, 1), intIn(a.time_ms, 0, HOUR)));
  });

  var turns = Array.isArray(body.turns) ? body.turns.slice(0, 120) : [];
  turns.forEach(function (t) {
    var n = intIn(t && t.turn_no, 0, 199);
    var role = oneOf(t && t.role, ['user', 'assistant']);
    if (n === null || !role) return;
    stmts.push(env.DB.prepare(
      'INSERT OR REPLACE INTO call_turns (session_id, turn_no, role, text, t_ms) VALUES (?, ?, ?, ?, ?)'
    ).bind(id, n, role, strMax(t.text, 800), intIn(t.t_ms, 0, 2 * HOUR)));
  });

  await env.DB.batch(stmts);
  return json({ ok: true }, 200, cors);
}

/* ---------------- admin ---------------- */
async function isAdmin(request, env) {
  if (!env.ADMIN_TOKEN) return false;
  var h = request.headers.get('Authorization') || '';
  var given = h.indexOf('Bearer ') === 0 ? h.slice(7) : '';
  // เทียบแบบเวลาคงที่ กันการเดา token ทีละตัวอักษรจากเวลาตอบสนอง
  var enc = new TextEncoder();
  var a = enc.encode(given), b = enc.encode(env.ADMIN_TOKEN);
  var diff = a.length ^ b.length;
  for (var i = 0; i < b.length; i++) diff |= (a[i] || 0) ^ b[i];
  return diff === 0;
}

function sessionFilter(url) {
  var where = [], args = [];
  var from = intIn(url.searchParams.get('from'), 0, 9e15);
  var to = intIn(url.searchParams.get('to'), 0, 9e15);
  var cls = strMax(url.searchParams.get('class'), 40);
  if (from !== null) { where.push('s.created_at >= ?'); args.push(from); }
  if (to !== null) { where.push('s.created_at < ?'); args.push(to); }
  if (cls) { where.push('s.class_code = ?'); args.push(cls); }
  return { sql: where.length ? ' WHERE ' + where.join(' AND ') : '', args: args };
}

async function adminData(url, env, cors) {
  var f = sessionFilter(url);
  var res = await env.DB.batch([
    env.DB.prepare(
      'SELECT s.*, d.school, d.program, d.year FROM sessions s ' +
      'LEFT JOIN student_directory d ON d.student_id = s.student_id' +
      f.sql + ' ORDER BY s.created_at DESC LIMIT ' + MAX_ADMIN_ROWS
    ).bind(...f.args),
    env.DB.prepare(
      'SELECT a.session_id, a.q_index, a.selected, a.correct, a.time_ms FROM answers a ' +
      'JOIN (SELECT s.id FROM sessions s' + f.sql + ' ORDER BY s.created_at DESC LIMIT ' + MAX_ADMIN_ROWS + ') x ' +
      'ON x.id = a.session_id'
    ).bind(...f.args),
    env.DB.prepare(
      'SELECT class_code, COUNT(*) AS n FROM sessions WHERE class_code IS NOT NULL GROUP BY class_code ORDER BY MAX(created_at) DESC'
    )
  ]);
  return json({
    generated_at: Date.now(),
    tracking: trackingOn(env),
    truncated: res[0].results.length >= MAX_ADMIN_ROWS,
    sessions: res[0].results,
    answers: res[1].results,
    classes: res[2].results
  }, 200, cors);
}

async function adminTranscript(url, env, cors) {
  var id = strMax(url.searchParams.get('id'), 40);
  if (!id) return json({ error: 'missing id' }, 400, cors);
  var r = await env.DB.prepare(
    'SELECT turn_no, role, text, t_ms FROM call_turns WHERE session_id = ? ORDER BY turn_no'
  ).bind(id).all();
  return json({ id: id, turns: r.results }, 200, cors);
}

async function adminDelete(request, env, cors) {
  var body;
  try { body = await request.json(); } catch (e) { return json({ error: 'bad_json' }, 400, cors); }
  var ids = (Array.isArray(body && body.ids) ? body.ids : []).map(function (x) { return strMax(x, 40); })
    .filter(Boolean).slice(0, 500);
  if (!ids.length) return json({ error: 'no ids' }, 400, cors);
  var stmts = [];
  ids.forEach(function (id) {
    stmts.push(env.DB.prepare('DELETE FROM answers WHERE session_id = ?').bind(id));
    stmts.push(env.DB.prepare('DELETE FROM call_turns WHERE session_id = ?').bind(id));
    stmts.push(env.DB.prepare('DELETE FROM sessions WHERE id = ?').bind(id));
  });
  await env.DB.batch(stmts);
  return json({ ok: true, deleted: ids.length }, 200, cors);
}
