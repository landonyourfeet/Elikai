// OPERATION: HYDRO STRIKE — RSVP Command Server
// Express + Postgres, deploys to Railway
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
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && /railway|amazonaws|render|heroku/.test(process.env.DATABASE_URL)
    ? { rejectUnauthorized: false }
    : false
});

async function initDB() {
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
  console.log('[DB] rsvps table ready');
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

// ----- Public RSVP page (with OG meta injection) -----
app.get('/', (req, res) => {
  try {
    const base = getBaseUrl(req);
    let html = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
    html = html.replace(/__BASE_URL__/g, base);
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.set('Cache-Control', 'public, max-age=300'); // 5min cache so unfurlers don't hammer
    res.send(html);
  } catch (err) {
    console.error('[/] error', err);
    res.status(500).send('Server error');
  }
});

// ----- Admin page (auth handled client-side via prompt + key in URL) -----
app.get('/admin', (req, res) => {
  res.set('X-Robots-Tag', 'noindex, nofollow');
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// ----- Static (invitation.jpg, share-card.jpg, etc.) -----
app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: '7d',
  etag: true
}));

// ----- Health check -----
app.get('/health', (req, res) => {
  res.json({ ok: true, ts: new Date().toISOString() });
});

// ----- Submit RSVP -----
app.post('/api/rsvp', async (req, res) => {
  try {
    const {
      parent_name,
      parent_phone,
      parent_email,
      kid_names,
      kid_count,
      attending,
      squad_preference,
      allergies,
      notes
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

    console.log(`[RSVP] #${result.rows[0].id} - ${parent_name} (${kid_names})`);
    res.json({ ok: true, id: result.rows[0].id });
  } catch (err) {
    console.error('[RSVP] error', err);
    res.status(500).json({ error: 'Server error — please try again' });
  }
});

// ----- Admin: list roster + stats -----
app.get('/api/rsvps', checkAdmin, async (req, res) => {
  try {
    const result = await pool.query(`SELECT * FROM rsvps ORDER BY created_at DESC`);
    const rows = result.rows;
    const yes = rows.filter(r => r.attending === 'YES');
    const stats = {
      total_rsvps: rows.length,
      yes: yes.length,
      no: rows.filter(r => r.attending === 'NO').length,
      maybe: rows.filter(r => r.attending === 'MAYBE').length,
      blue_squad: yes.filter(r => r.squad_preference === 'BLUE').length,
      red_squad: yes.filter(r => r.squad_preference === 'RED').length,
      no_pref: yes.filter(r => !r.squad_preference || r.squad_preference === 'EITHER').length,
      total_kids: yes.reduce((sum, r) => sum + (r.kid_count || 1), 0)
    };
    res.json({ stats, rsvps: rows });
  } catch (err) {
    console.error('[/api/rsvps]', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ----- Admin: delete an RSVP -----
app.delete('/api/rsvp/:id', checkAdmin, async (req, res) => {
  try {
    await pool.query(`DELETE FROM rsvps WHERE id = $1`, [parseInt(req.params.id) || 0]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ----- Boot -----
initDB().then(() => {
  app.listen(PORT, () => {
    console.log(`╔══════════════════════════════════════════╗`);
    console.log(`║  OPERATION: HYDRO STRIKE - RSVP COMMAND  ║`);
    console.log(`║  Online on port ${String(PORT).padEnd(24)} ║`);
    console.log(`║  Admin key: ${(ADMIN_KEY === 'changeme' ? '⚠ DEFAULT - SET ADMIN_KEY' : 'configured').padEnd(28)} ║`);
    console.log(`║  Public URL: ${(PUBLIC_URL || '(auto-detect from request)').padEnd(27)} ║`);
    console.log(`╚══════════════════════════════════════════╝`);
  });
}).catch(err => {
  console.error('[BOOT] DB init failed:', err);
  process.exit(1);
});
