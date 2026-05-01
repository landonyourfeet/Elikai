// OPERATION: HYDRO STRIKE — RSVP Command Server
// Express + Postgres, deploys to Railway
// Resilient: boots HTTP first, retries DB in background, won't crash-loop on DB issues
require('dotenv').config();

const express = require('express');
const path = require('path');
const fs = require('fs');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_KEY = process.env.ADMIN_KEY || 'changeme';
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/$/, '');

app.set('trust proxy', true);
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

// ----- Database -----
let pool = null;
let dbReady = false;

function buildPool() {
  if (!process.env.DATABASE_URL) {
    console.warn('[DB] DATABASE_URL not set — RSVPs will return 503 until Postgres is attached');
    return null;
  }
  return new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: /railway|amazonaws|render|heroku|supabase|neon/.test(process.env.DATABASE_URL)
      ? { rejectUnauthorized: false }
      : false,
    connectionTimeoutMillis: 8000,
    idleTimeoutMillis: 30000
  });
}

async function initDB() {
  if (!pool) pool = buildPool();
  if (!pool) return false;
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS rsvps (
        id SERIAL PRIMARY KEY,
        parent_name      TEXT NOT NULL,
        parent_phone     TEXT,
        parent_email     TEXT,
        kid_names        TEXT NOT NULL,
        kid_count        INTEGER DEFAULT 1,
        attending        TEXT NOT NULL DEFAULT 'YES',
        squad_preference TEXT,
        allergies        TEXT,
        notes            TEXT,
        ip               TEXT,
        user_agent       TEXT,
        created_at       TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS visits (
        id SERIAL PRIMARY KEY,
        ip          TEXT,
        user_agent  TEXT,
        referrer    TEXT,
        path        TEXT,
        created_at  TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_visits_created ON visits(created_at);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_visits_ip ON visits(ip);`);
    dbReady = true;
    console.log('[DB] tables ready ✓ (rsvps + visits)');
    return true;
  } catch (err) {
    dbReady = false;
    console.error('[DB] init failed:', err.message);
    return false;
  }
}

// Retry DB init in background until it works
async function dbWatchdog() {
  while (!dbReady) {
    const ok = await initDB();
    if (ok) break;
    await new Promise(r => setTimeout(r, 5000));
  }
}

// ----- Helpers -----
function getBaseUrl(req) {
  if (PUBLIC_URL) return PUBLIC_URL;
  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'https';
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return `${proto}://${host}`;
}

function checkAdmin(req, res, next) {
  const key = req.query.key || req.headers['x-admin-key'];
  if (!key || key !== ADMIN_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

function requireDB(req, res, next) {
  if (!dbReady) {
    return res.status(503).json({
      error: 'Database not connected yet. If you just deployed, wait 30s and retry. Otherwise check that Postgres is attached and DATABASE_URL is set.'
    });
  }
  next();
}

// ----- Public RSVP page (with OG meta injection + visit logging) -----
app.get('/', (req, res) => {
  try {
    const base = getBaseUrl(req);
    let html = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
    html = html.replace(/__BASE_URL__/g, base);
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.set('Cache-Control', 'public, max-age=300');
    res.send(html);

    // Fire-and-forget visit log. Skip obvious bots / link-preview crawlers
    // so the count reflects real human eyeballs.
    if (dbReady && pool) {
      const ua = (req.headers['user-agent'] || '').toLowerCase();
      const isBot = /bot|crawler|spider|facebookexternalhit|whatsapp|slackbot|telegram|discordbot|twitterbot|linkedinbot|preview|fetch|curl|wget|node-fetch|axios|python-requests|headlesschrome|googlebot|bingbot/.test(ua);
      if (!isBot) {
        const ip = (req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].trim();
        pool.query(
          `INSERT INTO visits (ip, user_agent, referrer, path) VALUES ($1,$2,$3,$4)`,
          [ip, (req.headers['user-agent'] || '').slice(0, 250), (req.headers.referer || '').slice(0, 250), '/']
        ).catch(err => console.error('[visit log]', err.message));
      }
    }
  } catch (err) {
    console.error('[/] error', err);
    res.status(500).send('Server error');
  }
});

// ----- Public stats endpoint — for the live counter on the page -----
app.get('/api/public-stats', async (req, res) => {
  try {
    if (!dbReady) return res.json({ confirmed_kids: 0, confirmed_families: 0, recruits: [], kid_names: [] });
    const r = await pool.query(
      `SELECT COALESCE(SUM(kid_count), 0)::int AS kids,
              COUNT(*)::int AS families
         FROM rsvps WHERE attending = 'YES'`
    );
    // Pull confirmed RSVPs with squad assignment
    const namesRes = await pool.query(
      `SELECT kid_names, squad_preference FROM rsvps WHERE attending = 'YES' ORDER BY created_at ASC`
    );

    // Parse out first names + their squad. kid_names field may be "Jackson + Mia", etc.
    // All kids in one RSVP share the same squad preference.
    const recruits = [];
    for (const row of namesRes.rows) {
      const raw = (row.kid_names || '').toString();
      const squad = (row.squad_preference || 'EITHER').toUpperCase();
      const parts = raw.split(/[+,&]|\band\b|\bw\/\b|\b\+\b|\//i);
      for (const p of parts) {
        const cleaned = p.trim().split(/\s+/)[0];
        if (cleaned && cleaned.length >= 2 && cleaned.length <= 20 && /^[A-Za-z][A-Za-z'\-]*$/.test(cleaned)) {
          const tc = cleaned.charAt(0).toUpperCase() + cleaned.slice(1).toLowerCase();
          recruits.push({ name: tc, squad: ['BLUE','RED','EITHER'].includes(squad) ? squad : 'EITHER' });
        }
      }
    }

    res.set('Cache-Control', 'public, max-age=30');
    res.json({
      confirmed_kids: r.rows[0].kids || 0,
      confirmed_families: r.rows[0].families || 0,
      recruits: recruits,
      // Backward-compat: keep kid_names array of just names
      kid_names: recruits.map(r => r.name)
    });
  } catch (err) {
    console.error('[/api/public-stats]', err);
    res.json({ confirmed_kids: 0, confirmed_families: 0, recruits: [], kid_names: [] });
  }
});

// ----- Admin page -----
app.get('/admin', (req, res) => {
  res.set('X-Robots-Tag', 'noindex, nofollow');
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// ----- Static assets -----
app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: '7d',
  etag: true
}));

// ----- Health check -----
app.get('/health', (req, res) => {
  res.json({
    ok: true,
    db: dbReady ? 'connected' : 'disconnected',
    public_url: PUBLIC_URL || '(auto-detect)',
    admin_key_set: ADMIN_KEY !== 'changeme',
    ts: new Date().toISOString()
  });
});

// ----- Submit RSVP -----
app.post('/api/rsvp', requireDB, async (req, res) => {
  try {
    const {
      parent_name, parent_phone, parent_email,
      kid_names, kid_count, attending,
      squad_preference, allergies, notes
    } = req.body || {};

    if (!parent_name || !String(parent_name).trim()) {
      return res.status(400).json({ error: 'Parent name is required' });
    }
    if (!kid_names || !String(kid_names).trim()) {
      return res.status(400).json({ error: 'Recruit name is required' });
    }

    const ip = (req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].trim();
    const ua = req.headers['user-agent'] || '';

    const result = await pool.query(
      `INSERT INTO rsvps
        (parent_name, parent_phone, parent_email, kid_names, kid_count,
         attending, squad_preference, allergies, notes, ip, user_agent)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       RETURNING id, created_at`,
      [
        String(parent_name).trim().slice(0, 100),
        (parent_phone || '').toString().trim().slice(0, 30) || null,
        (parent_email || '').toString().trim().slice(0, 120) || null,
        String(kid_names).trim().slice(0, 200),
        Math.min(20, parseInt(kid_count) || 1),
        (attending || 'YES').toString().toUpperCase().slice(0, 10),
        (squad_preference || '').toString().toUpperCase().slice(0, 10) || null,
        (allergies || '').toString().trim().slice(0, 500) || null,
        (notes || '').toString().trim().slice(0, 500) || null,
        ip,
        ua.slice(0, 200)
      ]
    );

    console.log(`[RSVP] #${result.rows[0].id} — ${parent_name} (${kid_names})`);
    res.json({ ok: true, id: result.rows[0].id });
  } catch (err) {
    console.error('[RSVP] error', err);
    res.status(500).json({ error: 'Server error — please try again' });
  }
});

// ----- Admin: list roster + stats + traffic -----
app.get('/api/rsvps', checkAdmin, requireDB, async (req, res) => {
  try {
    const result = await pool.query(`SELECT * FROM rsvps ORDER BY created_at DESC`);
    const rows = result.rows;
    const yes = rows.filter(r => r.attending === 'YES');

    // Traffic stats
    const totalVisits = await pool.query(`SELECT COUNT(*)::int AS c FROM visits`);
    const uniqueVisits = await pool.query(`SELECT COUNT(DISTINCT ip)::int AS c FROM visits WHERE ip IS NOT NULL AND ip <> ''`);
    const last24h = await pool.query(`SELECT COUNT(*)::int AS c FROM visits WHERE created_at > NOW() - INTERVAL '24 hours'`);
    const lastHour = await pool.query(`SELECT COUNT(*)::int AS c FROM visits WHERE created_at > NOW() - INTERVAL '1 hour'`);

    // Conversion: unique visitors who became RSVPs
    const visitorCount = uniqueVisits.rows[0].c || 0;
    const conversionPct = visitorCount > 0
      ? Math.round((yes.length / visitorCount) * 1000) / 10
      : 0;

    const stats = {
      total_rsvps: rows.length,
      yes: yes.length,
      no: rows.filter(r => r.attending === 'NO').length,
      maybe: rows.filter(r => r.attending === 'MAYBE').length,
      blue_squad: yes.filter(r => r.squad_preference === 'BLUE').length,
      red_squad: yes.filter(r => r.squad_preference === 'RED').length,
      no_pref: yes.filter(r => !r.squad_preference || r.squad_preference === 'EITHER').length,
      total_kids: yes.reduce((sum, r) => sum + (r.kid_count || 1), 0),
      // Traffic
      page_views: totalVisits.rows[0].c || 0,
      unique_visitors: visitorCount,
      visits_24h: last24h.rows[0].c || 0,
      visits_1h: lastHour.rows[0].c || 0,
      conversion_pct: conversionPct
    };
    res.json({ stats, rsvps: rows });
  } catch (err) {
    console.error('[/api/rsvps]', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ----- Admin: delete an RSVP -----
app.delete('/api/rsvp/:id', checkAdmin, requireDB, async (req, res) => {
  try {
    await pool.query(`DELETE FROM rsvps WHERE id = $1`, [parseInt(req.params.id) || 0]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ----- Admin: reassign squad on an RSVP -----
app.patch('/api/rsvp/:id/squad', checkAdmin, requireDB, async (req, res) => {
  try {
    const id = parseInt(req.params.id) || 0;
    const squad = (req.body && req.body.squad || '').toString().toUpperCase();
    if (!['BLUE', 'RED', 'EITHER'].includes(squad)) {
      return res.status(400).json({ error: 'squad must be BLUE, RED, or EITHER' });
    }
    const result = await pool.query(
      `UPDATE rsvps SET squad_preference = $1 WHERE id = $2 RETURNING id, kid_names, squad_preference`,
      [squad, id]
    );
    if (!result.rowCount) {
      return res.status(404).json({ error: 'RSVP not found' });
    }
    console.log(`[SQUAD] #${id} → ${squad} (${result.rows[0].kid_names})`);
    res.json({ ok: true, rsvp: result.rows[0] });
  } catch (err) {
    console.error('[squad reassign]', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ----- Boot: HTTP first, DB connects in background -----
app.listen(PORT, () => {
  console.log(`╔════════════════════════════════════════════╗`);
  console.log(`║  OPERATION: HYDRO STRIKE - RSVP COMMAND    ║`);
  console.log(`║  HTTP online on port ${String(PORT).padEnd(22)}║`);
  console.log(`║  Admin key: ${(ADMIN_KEY === 'changeme' ? '⚠ DEFAULT (set ADMIN_KEY)' : 'set ✓').padEnd(31)}║`);
  console.log(`║  Public URL: ${(PUBLIC_URL || '(auto from request)').padEnd(30)}║`);
  console.log(`║  DB URL:    ${(process.env.DATABASE_URL ? 'set, connecting...' : '⚠ NOT SET — attach Postgres').padEnd(31)}║`);
  console.log(`╚════════════════════════════════════════════╝`);
  dbWatchdog();
});

process.on('unhandledRejection', (err) => {
  console.error('[unhandledRejection]', err);
});
