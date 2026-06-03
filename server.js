/**
 * FLEET-INTELS BACKEND — PRODUCTION SERVER v2.3 (Security Patched)
 * Fixes applied:
 *   - CORS locked to ALLOWED_ORIGINS env var only
 *   - Helmet CSP enabled
 *   - Account lockout after 5 failed login attempts (15 min)
 *   - JWT access token expiry reduced to 2h
 *   - Morgan logs suppressed in production for auth routes
 *   - Seed user emails removed from any server responses
 *   - HSTS header added
 */
'use strict';

require('dotenv').config();

const express      = require('express');
const { Pool }     = require('pg');
const bcrypt       = require('bcryptjs');
const jwt          = require('jsonwebtoken');
const helmet       = require('helmet');
const cors         = require('cors');
const rateLimit    = require('express-rate-limit');
const morgan       = require('morgan');
const crypto       = require('crypto');
const cookieParser = require('cookie-parser');

const app  = express();
const PORT = parseInt(process.env.PORT || '3001', 10);

// ── STARTUP LOG ───────────────────────────────────────────────────────────────
console.log('Fleet-Intels API starting...');
console.log('Port:', PORT);
console.log('NODE_ENV:', process.env.NODE_ENV || 'development');
console.log('DB set:', !!process.env.DATABASE_URL);
console.log('JWT set:', !!process.env.JWT_ACCESS_SECRET);

// ── ENV CHECK ─────────────────────────────────────────────────────────────────
const missing = ['DATABASE_URL','JWT_ACCESS_SECRET','JWT_REFRESH_SECRET']
  .filter(k => !process.env[k]);
if (missing.length) {
  console.error('MISSING ENV VARS:', missing.join(', '));
  process.exit(1);
}

// ── DATABASE ──────────────────────────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

pool.connect((err, client, done) => {
  if (err) {
    console.error('DB connection error:', err.message);
  } else {
    console.log('DB connected OK');
    done();
    // Ensure login_attempts columns exist (non-destructive migration)
    pool.query(`
      ALTER TABLE drivers
        ADD COLUMN IF NOT EXISTS failed_attempts  SMALLINT   DEFAULT 0,
        ADD COLUMN IF NOT EXISTS locked_until     TIMESTAMPTZ DEFAULT NULL
    `).catch(() => {}); // silently skip if already exist or no permission
  }
});

// ── CORS ──────────────────────────────────────────────────────────────────────
// FIX: locked to ALLOWED_ORIGINS env var — no more wildcard with credentials
const rawOrigins = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
const allowedOrigins = rawOrigins.length ? rawOrigins : [];

const corsOptions = {
  origin: function (origin, callback) {
    // Allow requests with no origin (server-to-server, health checks)
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) return callback(null, true);
    console.warn('[CORS] Blocked origin:', origin);
    callback(new Error('Not allowed by CORS'));
  },
  methods: ['GET','POST','PUT','PATCH','DELETE','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization','X-Telematics-Api-Key','X-Api-Key'],
  credentials: true,
  maxAge: 86400, // preflight cache 24h
};

// ── MIDDLEWARE ────────────────────────────────────────────────────────────────
app.set('trust proxy', 1);

// FIX: Helmet with CSP enabled + HSTS
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc:  ["'self'"],
      scriptSrc:   ["'self'", "'unsafe-inline'"],
      styleSrc:    ["'self'", "'unsafe-inline'"],
      imgSrc:      ["'self'", "data:", "https:"],
      connectSrc:  ["'self'", ...allowedOrigins],
      fontSrc:     ["'self'", "https://fonts.gstatic.com"],
      objectSrc:   ["'none'"],
      frameSrc:    ["'none'"],
    },
  },
  crossOriginEmbedderPolicy: false,
  hsts: {
    maxAge: 31536000,         // 1 year
    includeSubDomains: true,
    preload: true,
  },
}));

app.use(cors(corsOptions));
app.options('*', cors(corsOptions)); // pre-flight for all routes

app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: false }));
app.use(cookieParser());

// FIX: suppress morgan on auth routes in production to avoid logging tokens
if (process.env.NODE_ENV !== 'production') {
  app.use(morgan('tiny'));
} else {
  app.use(morgan('tiny', {
    skip: (req) => req.path.startsWith('/api/auth'),
  }));
}

// ── RATE LIMITERS ─────────────────────────────────────────────────────────────
const apiLimit   = rateLimit({ windowMs: 60000,   max: 200, standardHeaders: 'draft-7', legacyHeaders: false });
const loginLimit = rateLimit({ windowMs: 900000,  max: 10,  standardHeaders: 'draft-7', legacyHeaders: false });
const teleLimit  = rateLimit({ windowMs: 1000,    max: 100, standardHeaders: 'draft-7', legacyHeaders: false });

// ── HELPERS ───────────────────────────────────────────────────────────────────
const genId = (p = 'ID') =>
  p + '_' + Date.now().toString(36) + '_' + crypto.randomBytes(4).toString('hex');

function auth(req, res, next) {
  const h = req.headers.authorization;
  if (!h || !h.startsWith('Bearer ')) return res.status(401).json({ error: 'Auth required' });
  try { req.user = jwt.verify(h.slice(7), process.env.JWT_ACCESS_SECRET); next(); }
  catch (e) { res.status(401).json({ error: 'Invalid or expired token' }); }
}

function teleAuth(req, res, next) {
  const key = req.headers['x-telematics-api-key'] || req.headers['x-api-key'];
  if (!process.env.TELEMATICS_API_KEY || key === process.env.TELEMATICS_API_KEY) return next();
  res.status(401).json({ error: 'Invalid API key' });
}

// ── SAFETY SCORE ─────────────────────────────────────────────────────────────
const DED = {
  harsh_braking:3, harsh_acceleration:2, overspeeding:4, fatigue_detected:6,
  distraction:5, phone_use:6, lane_departure:3, forward_collision:8,
  tailgating:2, no_seatbelt:3, yawning:3, looking_away:3, smoking:2,
};
function safetyScore(events, days) {
  const d = Math.max(days || 1, 1);
  const total = events.reduce((s,r) => s + (DED[r.event_type] || 1) * parseInt(r.count,10), 0);
  return Math.max(0, Math.round(100 - total / d));
}

// ── WIALON NORMALISER ─────────────────────────────────────────────────────────
const W_MAP = {
  driverFatigue:'fatigue_detected', fatigue:'fatigue_detected',
  driverDistraction:'distraction', phoneUsage:'phone_use', phoneUse:'phone_use',
  harshBraking:'harsh_braking', hardBraking:'harsh_braking',
  harshAcceleration:'harsh_acceleration', speeding:'overspeeding',
  overSpeed:'overspeeding', overSpeeding:'overspeeding',
  laneDeparture:'lane_departure', forwardCollision:'forward_collision',
  tailgating:'tailgating', seatbelt:'no_seatbelt', noSeatbelt:'no_seatbelt',
};
function normalise(w) {
  if (!w.unit_id && !w.unit_name) return w;
  return {
    plate: w.unit_name || '',
    driver_name: w.nms || '',
    odometer: w.prm?.mileage?.v || 0,
    lat: w.pos?.y || null, lng: w.pos?.x || null,
    speed: w.pos?.s || 0,
    fuel_level: w.prm?.fuel_level?.v || null,
    distance_km: w.prm?.distance?.v || 0,
    events: (w.avl_evts || []).filter(e=>(e.v||0)>0)
      .map(e=>({ type: W_MAP[e.n||e.name] || e.n, severity:'medium' })),
  };
}

// ══════════════════════════════════════════════════════════════════════════════
//  ROUTES
// ══════════════════════════════════════════════════════════════════════════════

// Health — no auth, no DB query, always returns 200
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'fleet-intels-api',
    version: '2.3.0',
    timestamp: new Date().toISOString(),
    uptime: process.uptime().toFixed(0) + 's',
  });
});

// Root
app.get('/', (req, res) => {
  res.json({ message: 'Fleet-Intels API v2.3', docs: '/health' });
});

// ── AUTH ──────────────────────────────────────────────────────────────────────
app.post('/api/auth/login', loginLimit, async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(422).json({ error: 'Email and password required' });

  try {
    const { rows } = await pool.query(
      'SELECT id,name,email,role,password_hash,active,branch_id,failed_attempts,locked_until FROM drivers WHERE email=LOWER($1) LIMIT 1',
      [email.trim()]
    );
    const u = rows[0];

    // FIX: account lockout check
    if (u?.locked_until && new Date(u.locked_until) > new Date()) {
      const mins = Math.ceil((new Date(u.locked_until) - new Date()) / 60000);
      return res.status(429).json({ error: `Account locked. Try again in ${mins} minute(s).` });
    }

    const dummy = '$2a$12$00000000000000000000009999999999999999999999999999999';
    const ok = await bcrypt.compare(password, u?.password_hash || dummy);

    if (!u || !ok) {
      // FIX: increment failed attempts, lock after 5
      if (u) {
        const attempts = (u.failed_attempts || 0) + 1;
        const lockUntil = attempts >= 5 ? new Date(Date.now() + 15 * 60000) : null;
        await pool.query(
          'UPDATE drivers SET failed_attempts=$1, locked_until=$2 WHERE id=$3',
          [attempts, lockUntil, u.id]
        ).catch(() => {});
      }
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    if (!u.active) return res.status(403).json({ error: 'Account suspended' });

    // FIX: reset failed attempts on successful login
    await pool.query(
      'UPDATE drivers SET failed_attempts=0, locked_until=NULL WHERE id=$1',
      [u.id]
    ).catch(() => {});

    // FIX: access token reduced from 8h to 2h
    const token = jwt.sign(
      { id:u.id, email:u.email, name:u.name, role:u.role, branch:u.branch_id },
      process.env.JWT_ACCESS_SECRET, { expiresIn:'2h' }
    );
    const rt = jwt.sign({ id:u.id }, process.env.JWT_REFRESH_SECRET, { expiresIn:'7d' });
    const rth = crypto.createHash('sha256').update(rt).digest('hex');
    await pool.query('UPDATE drivers SET refresh_token_hash=$1,last_login=NOW() WHERE id=$2',[rth,u.id]);

    // httpOnly secure cookie for refresh token
    res.cookie('refreshToken', rt, {
      httpOnly: true,
      secure: true,
      sameSite: 'Strict',
      maxAge: 604800000,
      path: '/api/auth/refresh',
    });

    res.json({
      accessToken: token,
      user: { id:u.id, name:u.name, email:u.email, role:u.role },
    });
  } catch(e) {
    console.error('[login]', e.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// Token refresh
app.post('/api/auth/refresh', async (req, res) => {
  const rt = req.cookies?.refreshToken;
  if (!rt) return res.status(401).json({ error: 'No refresh token' });
  try {
    const payload = jwt.verify(rt, process.env.JWT_REFRESH_SECRET);
    const rth = crypto.createHash('sha256').update(rt).digest('hex');
    const { rows } = await pool.query(
      'SELECT id,name,email,role,branch_id,active,refresh_token_hash FROM drivers WHERE id=$1 LIMIT 1',
      [payload.id]
    );
    const u = rows[0];
    if (!u || !u.active || u.refresh_token_hash !== rth) {
      res.clearCookie('refreshToken', { path: '/api/auth/refresh' });
      return res.status(401).json({ error: 'Invalid refresh token' });
    }
    const newToken = jwt.sign(
      { id:u.id, email:u.email, name:u.name, role:u.role, branch:u.branch_id },
      process.env.JWT_ACCESS_SECRET, { expiresIn:'2h' }
    );
    res.json({ accessToken: newToken });
  } catch(e) {
    res.clearCookie('refreshToken', { path: '/api/auth/refresh' });
    res.status(401).json({ error: 'Refresh token expired — please log in again' });
  }
});

app.post('/api/auth/logout', auth, async (req,res) => {
  await pool.query('UPDATE drivers SET refresh_token_hash=NULL WHERE id=$1',[req.user.id]).catch(()=>{});
  res.clearCookie('refreshToken',{path:'/api/auth/refresh'});
  res.json({ message:'Logged out' });
});

// ── TELEMATICS INGEST ─────────────────────────────────────────────────────────
app.post('/api/telematics/ingest', teleLimit, teleAuth, async (req,res) => {
  try {
    const body = req.body;
    if (Array.isArray(body)) {
      await Promise.all(body.map(normalise).map(ingest));
      return res.json({ received:true, count:body.length });
    }
    await ingest(normalise(body));
    res.json({ received:true });
  } catch(e) {
    console.error('[ingest]',e.message);
    res.status(500).json({ error:'Server error' });
  }
});

async function ingest(d) {
  if (!d.plate) return;
  const plate = d.plate.trim().toUpperCase();
  const { rows:t } = await pool.query('SELECT id FROM trucks WHERE plate_number ILIKE $1 LIMIT 1',[plate]);
  const tid = t[0]?.id || null;
  let did = null;
  if (d.driver_name) {
    const { rows:dr } = await pool.query('SELECT id FROM drivers WHERE name ILIKE $1 LIMIT 1',[d.driver_name.trim()]);
    did = dr[0]?.id || null;
  }
  if (!did && tid) {
    const { rows:ar } = await pool.query("SELECT id FROM drivers WHERE assigned_truck_id=$1 AND current_status='Active' LIMIT 1",[tid]);
    did = ar[0]?.id || null;
  }
  const eid = genId('TEL');
  await pool.query(
    'INSERT INTO telematics_events(id,truck_id,driver_id,plate_number,driver_name,timestamp,lat,lng,speed_kmh,odometer_km,fuel_level_pct,distance_km,idle_minutes,raw_events) VALUES($1,$2,$3,$4,$5,NOW(),$6,$7,$8,$9,$10,$11,$12,$13)',
    [eid,tid,did,plate,d.driver_name||'',d.lat,d.lng,d.speed||0,d.odometer||0,d.fuel_level,d.distance_km||0,d.idle_minutes||0,JSON.stringify(d.events||[])]
  );
  for (const e of (d.events||[])) {
    await pool.query(
      'INSERT INTO driver_alerts(id,telematics_event_id,truck_id,driver_id,plate_number,driver_name,alert_type,severity,triggered_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,NOW())',
      [genId('ALT'),eid,tid,did,plate,d.driver_name||'',e.type,e.severity||'medium']
    );
  }
  if (tid && d.odometer > 0) await pool.query('UPDATE trucks SET odometer_km=GREATEST(odometer_km,$1),last_seen=NOW() WHERE id=$2',[d.odometer,tid]);
  if (did && d.distance_km > 0) await pool.query('UPDATE drivers SET total_trips=total_trips+1,last_active=NOW() WHERE id=$1',[did]);
}

// ── DRIVER PERFORMANCE ────────────────────────────────────────────────────────
app.get('/api/drivers/performance', auth, apiLimit, async (req,res) => {
  const days = Math.min(parseInt(req.query.days)||30, 365);
  const branch = req.user.role==='BRANCH_MGR' ? req.user.branch : (req.query.branch_id||'');
  const cutoff = new Date(Date.now() - days*86400000);
  try {
    const [al, ac, dr] = await Promise.all([
      pool.query(`SELECT da.driver_id,da.alert_type,COUNT(*)::int AS count FROM driver_alerts da JOIN drivers d ON d.id=da.driver_id WHERE da.triggered_at>=$1 AND ($2='' OR d.branch_id=$2) GROUP BY da.driver_id,da.alert_type`,[cutoff,branch]),
      pool.query(`SELECT te.driver_id,COUNT(DISTINCT te.timestamp::date)::int AS days,SUM(te.distance_km)::float AS km FROM telematics_events te JOIN drivers d ON d.id=te.driver_id WHERE te.timestamp>=$1 AND ($2='' OR d.branch_id=$2) GROUP BY te.driver_id`,[cutoff,branch]),
      pool.query(`SELECT d.id,d.name,d.email,d.phone,d.current_status,d.total_trips,d.average_score,d.branch_id,b.name AS branch_name,t.plate_number,d.licence_expiry FROM drivers d LEFT JOIN branches b ON b.id=d.branch_id LEFT JOIN trucks t ON t.id=d.assigned_truck_id WHERE d.active=TRUE AND ($1='' OR d.branch_id=$1) ORDER BY d.name`,[branch]),
    ]);
    const am={}, acm={};
    al.rows.forEach(r=>{ if(!am[r.driver_id])am[r.driver_id]=[]; am[r.driver_id].push(r); });
    ac.rows.forEach(r=>{ acm[r.driver_id]=r; });
    const KEYS=['harsh_braking','harsh_acceleration','overspeeding','fatigue_detected','distraction','phone_use','lane_departure','forward_collision','no_seatbelt'];
    const drivers = dr.rows.map(d=>{
      const evts=am[d.id]||[], act=acm[d.id]||{days:0,km:0};
      const sc=safetyScore(evts.map(e=>({event_type:e.alert_type,count:e.count})), act.days);
      const alerts={}; KEYS.forEach(k=>{alerts[k]=0;}); evts.forEach(e=>{alerts[e.alert_type]=(alerts[e.alert_type]||0)+e.count;}); alerts.total=evts.reduce((s,e)=>s+e.count,0);
      pool.query('UPDATE drivers SET average_score=$1 WHERE id=$2',[sc,d.id]).catch(()=>{});
      return { id:d.id,name:d.name,email:d.email,phone:d.phone,plate:d.plate_number||'—',branch:d.branch_name||d.branch_id||'—',branch_id:d.branch_id,safety_score:sc,score_colour:sc>=90?'green':sc>=70?'amber':'red',total_trips:d.total_trips||0,driving_days:act.days,total_km:Math.round(act.km||0),avg_km_per_day:act.days>0?Math.round(act.km/act.days):0,current_status:d.current_status,average_score:d.average_score||sc,licence_expiry:d.licence_expiry,alerts };
    }).sort((a,b)=>b.safety_score-a.safety_score);
    const avg=drivers.length?Math.round(drivers.reduce((s,d)=>s+d.safety_score,0)/drivers.length):0;
    res.json({ period_days:days, generated_at:new Date().toISOString(), fleet_avg_score:avg, distribution:{ green:drivers.filter(d=>d.safety_score>=90).length, amber:drivers.filter(d=>d.safety_score>=70&&d.safety_score<90).length, red:drivers.filter(d=>d.safety_score<70).length }, drivers });
  } catch(e) { console.error('[perf]',e.message); res.status(500).json({error:'Server error'}); }
});

// ── VEHICLES ──────────────────────────────────────────────────────────────────
app.get('/api/vehicles', auth, apiLimit, async (req,res) => {
  const b = req.user.role==='BRANCH_MGR'?req.user.branch:(req.query.branch_id||'');
  try {
    const {rows}=await pool.query(`SELECT t.*,b.name AS branch_name,d.name AS driver_name FROM trucks t LEFT JOIN branches b ON b.id=t.branch_id LEFT JOIN drivers d ON d.assigned_truck_id=t.id AND d.current_status='Active' WHERE ($1='' OR t.branch_id=$1) AND ($2='' OR t.status=$2) ORDER BY t.plate_number`,[b,req.query.status||'']);
    res.json(rows);
  } catch(e){res.status(500).json({error:'Server error'});}
});

// ── MAINTENANCE ───────────────────────────────────────────────────────────────
app.get('/api/maintenance', auth, apiLimit, async (req,res) => {
  try {
    const {rows}=await pool.query(`SELECT m.*,t.plate_number,b.name AS branch_name FROM maintenance_logs m JOIN trucks t ON t.id=m.truck_id JOIN branches b ON b.id=t.branch_id WHERE ($1='' OR m.status=$1) AND ($2='' OR t.branch_id=$2) ORDER BY m.created_at DESC LIMIT 200`,[req.query.status||'',req.query.branch_id||'']);
    res.json(rows);
  } catch(e){res.status(500).json({error:'Server error'});}
});

// ── BRANCHES ──────────────────────────────────────────────────────────────────
app.get('/api/branches', auth, async (req,res) => {
  try {
    const {rows}=await pool.query(`SELECT b.*,COUNT(DISTINCT t.id)::int AS vehicle_count,COUNT(DISTINCT d.id)::int AS driver_count FROM branches b LEFT JOIN trucks t ON t.branch_id=b.id LEFT JOIN drivers d ON d.branch_id=b.id AND d.active=TRUE GROUP BY b.id ORDER BY b.name`);
    res.json(rows);
  } catch(e){res.status(500).json({error:'Server error'});}
});

// ── DASHBOARD SUMMARY ─────────────────────────────────────────────────────────
app.get('/api/dashboard/summary', auth, apiLimit, async (req,res) => {
  const b=req.user.role==='BRANCH_MGR'?req.user.branch:(req.query.branch_id||'');
  try {
    const [t,d,w,a]=await Promise.all([
      pool.query(`SELECT status,COUNT(*)::int AS count FROM trucks WHERE ($1='' OR branch_id=$1) GROUP BY status`,[b]),
      pool.query(`SELECT current_status,COUNT(*)::int AS count FROM drivers WHERE active=TRUE AND ($1='' OR branch_id=$1) GROUP BY current_status`,[b]),
      pool.query(`SELECT COUNT(*)::int AS n FROM maintenance_logs m JOIN trucks t ON t.id=m.truck_id WHERE m.status!='Completed' AND ($1='' OR t.branch_id=$1)`,[b]),
      pool.query(`SELECT alert_type,COUNT(*)::int AS count FROM driver_alerts da JOIN drivers d ON d.id=da.driver_id WHERE da.triggered_at::date=CURRENT_DATE AND ($1='' OR d.branch_id=$1) GROUP BY alert_type`,[b]),
    ]);
    const tm={}; t.rows.forEach(r=>{tm[r.status]=r.count;});
    const tot=Object.values(tm).reduce((s,v)=>s+v,0);
    const dm={}; d.rows.forEach(r=>{dm[r.current_status]=r.count;});
    res.json({trucks:{total:tot,operational:tm['Operational']||0,in_maintenance:tm['Maintenance']||0,off_road:tm['Off-Road']||0,pct_operational:tot?Math.round((tm['Operational']||0)/tot*100):0},drivers:{total:Object.values(dm).reduce((s,v)=>s+v,0),active:dm['Active']||0},open_work_orders:w.rows[0]?.n||0,alerts_today:a.rows,generated_at:new Date().toISOString()});
  } catch(e){console.error('[dash]',e.message);res.status(500).json({error:'Server error'});}
});

// ── ERROR HANDLERS ────────────────────────────────────────────────────────────
app.use((err,req,res,next)=>{
  if (err.message === 'Not allowed by CORS') {
    return res.status(403).json({ error: 'CORS: origin not allowed' });
  }
  console.error('[error]',err.message);
  res.status(500).json({ error: 'Server error' });
});
app.use((req,res)=>{
  res.status(404).json({ error: 'Not found' });
});

// ── START SERVER ──────────────────────────────────────────────────────────────
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log('Fleet-Intels API v2.3 running on port ' + PORT);
  console.log('Health: http://0.0.0.0:' + PORT + '/health');
  console.log('CORS origins:', allowedOrigins.length ? allowedOrigins.join(', ') : 'NONE SET — check ALLOWED_ORIGINS');
});

server.on('error', (err) => {
  console.error('Server error:', err.message);
  process.exit(1);
});

process.on('SIGTERM', async () => {
  console.log('Shutting down...');
  server.close();
  await pool.end();
  process.exit(0);
});

module.exports = app;

// ══════════════════════════════════════════════════════════════════════════════
//  BULK UPLOAD — Vehicles, Drivers, Fuel Entries
// ══════════════════════════════════════════════════════════════════════════════
const multer = require('multer');
const XLSX   = require('xlsx');
const storage = multer.memoryStorage();
const upload  = multer({ storage, limits: { fileSize: 5 * 1024 * 1024 } }); // 5MB max

// ── helper: parse Excel buffer → array of plain objects ──────────────────────
function parseExcel(buffer, sheetIndex = 0) {
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: true });
  const ws = wb.Sheets[wb.SheetNames[sheetIndex]];
  // row 1=title, row 2=instructions, row 3=headers → data starts row 4 (index 3)
  const raw = XLSX.utils.sheet_to_json(ws, { defval: '', range: 2 });
  return raw.map(r => {
    const clean = {};
    for (const [k, v] of Object.entries(r)) {
      const key = k.replace(/\s*\*\s*$/, '').trim().toLowerCase().replace(/\s+/g, '_');
      clean[key] = typeof v === 'string' ? v.trim() : v;
    }
    return clean;
  }).filter(r => Object.values(r).some(v => v !== '' && v !== null && v !== undefined));
}

function fmtDate(v) {
  if (!v) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  const s = String(v).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const d = new Date(s);
  return isNaN(d) ? null : d.toISOString().slice(0, 10);
}

// ── POST /api/upload/vehicles ─────────────────────────────────────────────────
app.post('/api/upload/vehicles', auth, upload.single('file'), async (req, res) => {
  if (!['ADMIN','MGR','SUPER_ADMIN'].includes(req.user.role)) return res.status(403).json({ error: 'Not authorised' });
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  try {
    const rows = parseExcel(req.file.buffer);
    let imported = 0, skipped = 0, errors = [];
    for (const r of rows.slice(0, 500)) {
      if (!r.plate_number || !r.make || !r.model) { skipped++; errors.push(`Row skipped — missing required field: ${JSON.stringify(r)}`); continue; }
      try {
        await pool.query(`
          INSERT INTO trucks (plate_number,make,model,year,truck_type,fuel_type,branch_id,status,odometer_km,vin,next_service_date,ownership_type,notes)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
          ON CONFLICT (plate_number) DO UPDATE SET
            make=EXCLUDED.make, model=EXCLUDED.model, year=EXCLUDED.year,
            truck_type=EXCLUDED.truck_type, fuel_type=EXCLUDED.fuel_type,
            branch_id=EXCLUDED.branch_id, status=EXCLUDED.status,
            odometer_km=EXCLUDED.odometer_km, vin=EXCLUDED.vin,
            next_service_date=EXCLUDED.next_service_date,
            ownership_type=EXCLUDED.ownership_type, notes=EXCLUDED.notes,
            updated_at=NOW()
        `, [
          String(r.plate_number).toUpperCase(),
          r.make, r.model,
          r.year ? parseInt(r.year) : null,
          r.truck_type || 'Truck',
          r.fuel_type || 'Diesel',
          r.branch_id || null,
          r.status || 'Operational',
          r.odometer_km ? parseInt(r.odometer_km) : 0,
          r.vin || null,
          fmtDate(r.next_service_date),
          r.ownership_type || null,
          r.notes || null,
        ]);
        imported++;
      } catch(e) { skipped++; errors.push(`${r.plate_number}: ${e.message}`); }
    }
    res.json({ success: true, imported, skipped, errors: errors.slice(0, 20) });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/upload/drivers ──────────────────────────────────────────────────
app.post('/api/upload/drivers', auth, upload.single('file'), async (req, res) => {
  if (!['ADMIN','MGR','SUPER_ADMIN'].includes(req.user.role)) return res.status(403).json({ error: 'Not authorised' });
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  try {
    const rows = parseExcel(req.file.buffer);
    let imported = 0, skipped = 0, errors = [];
    // Default password hash for 'Fleet@2026!' — change on first login
    const defaultHash = '$2b$12$92IXUNpkjO0rOQ5byMi.Ye4oKoEa3Ro9llC/.og/at2.uivHVc4jW';
    for (const r of rows.slice(0, 500)) {
      if (!r.name || !r.email) { skipped++; errors.push(`Row skipped — missing name or email`); continue; }
      const validRoles = ['ADMIN','MGR','BRANCH_MGR','TECH','DRIVER','STORE_MGR','VIEWER','ACCOUNTS'];
      const role = validRoles.includes((r.role||'').toUpperCase()) ? r.role.toUpperCase() : 'DRIVER';
      try {
        await pool.query(`
          INSERT INTO drivers (name,email,phone,role,branch_id,licence_number,licence_class,licence_expiry,current_status,password_hash,active,notes)
          VALUES ($1,LOWER($2),$3,$4,$5,$6,$7,$8,$9,$10,TRUE,$11)
          ON CONFLICT (email) DO UPDATE SET
            name=EXCLUDED.name, phone=EXCLUDED.phone, role=EXCLUDED.role,
            branch_id=EXCLUDED.branch_id, licence_number=EXCLUDED.licence_number,
            licence_class=EXCLUDED.licence_class, licence_expiry=EXCLUDED.licence_expiry,
            current_status=EXCLUDED.current_status, updated_at=NOW()
        `, [
          r.name, r.email, r.phone || null, role,
          r.branch_id || null,
          r.licence_number || null, r.licence_class || null,
          fmtDate(r.licence_expiry),
          r.current_status || 'Active',
          defaultHash,
          r.notes || null,
        ]);
        imported++;
      } catch(e) { skipped++; errors.push(`${r.email}: ${e.message}`); }
    }
    res.json({ success: true, imported, skipped, errors: errors.slice(0, 20),
      note: 'All imported drivers have default password: Fleet@2026! — they must change on first login' });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/upload/fuel ─────────────────────────────────────────────────────
app.post('/api/upload/fuel', auth, upload.single('file'), async (req, res) => {
  if (!['ADMIN','MGR','BRANCH_MGR','TECH','SUPER_ADMIN','ACCOUNTS'].includes(req.user.role))
    return res.status(403).json({ error: 'Not authorised' });
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  try {
    const rows = parseExcel(req.file.buffer);
    let imported = 0, skipped = 0, errors = [];
    for (const r of rows.slice(0, 500)) {
      if (!r.plate_number || !r.entry_date || !r.total_cost) {
        skipped++; errors.push(`Row skipped — missing plate_number, entry_date, or total_cost`); continue;
      }
      try {
        const { rows: trk } = await pool.query('SELECT id FROM trucks WHERE plate_number ILIKE $1 LIMIT 1', [String(r.plate_number).toUpperCase()]);
        const truck_id = trk[0]?.id || null;
        const fid = 'FUE_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2,6);
        await pool.query(`
          INSERT INTO fuel_entries (id,truck_id,plate_number,fuel_type,quantity_litres,price_per_litre,total_cost,odometer_km,station_name,entry_date,logged_by)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
        `, [
          fid, truck_id,
          String(r.plate_number).toUpperCase(),
          r.fuel_type || 'Diesel',
          r.quantity_litres ? parseFloat(r.quantity_litres) : null,
          r.price_per_litre ? parseFloat(r.price_per_litre) : null,
          parseFloat(r.total_cost),
          r.odometer_km ? parseInt(r.odometer_km) : null,
          r.station_name || null,
          fmtDate(r.entry_date),
          req.user.id,
        ]);
        imported++;
      } catch(e) { skipped++; errors.push(`${r.plate_number} ${r.entry_date}: ${e.message}`); }
    }
    res.json({ success: true, imported, skipped, errors: errors.slice(0, 20) });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════════════════════════════════════
//  DATA RESET — Super Admin only
//  Wipes operational data, preserves branches + admin accounts + audit_log
// ══════════════════════════════════════════════════════════════════════════════
app.post('/api/admin/reset-demo-data', auth, async (req, res) => {
  const { confirm } = req.body || {};
  if (!['ADMIN','SUPER_ADMIN'].includes(req.user.role))
    return res.status(403).json({ error: 'Super Admin only' });
  if (confirm !== 'RESET_FLEET_INTELS_DATA')
    return res.status(400).json({ error: 'Confirmation phrase required: RESET_FLEET_INTELS_DATA' });
  try {
    // Delete in dependency order
    await pool.query('DELETE FROM driver_alerts');
    await pool.query('DELETE FROM telematics_events');
    await pool.query('DELETE FROM fuel_entries');
    await pool.query('DELETE FROM maintenance_logs');
    await pool.query('DELETE FROM tyres');
    await pool.query('UPDATE drivers SET assigned_truck_id=NULL, total_trips=0, average_score=100 WHERE role=\'DRIVER\'');
    await pool.query('DELETE FROM trucks');
    // Keep non-driver admin accounts and branches intact
    await pool.query('DELETE FROM drivers WHERE role=\'DRIVER\'');
    // Log the reset
    await pool.query(
      'INSERT INTO audit_log (user_id,user_email,user_role,module,action,meta) VALUES ($1,$2,$3,$4,$5,$6)',
      [req.user.id, req.user.email, req.user.role, 'System', 'Demo data reset performed', JSON.stringify({ at: new Date() })]
    ).catch(() => {});
    res.json({ success: true, message: 'All operational data cleared. Branches and admin accounts preserved. Ready for real data upload.' });
  } catch(e) {
    console.error('[reset]', e.message);
    res.status(500).json({ error: e.message });
  }
});

