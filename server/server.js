/**
 * CARTEENACLUB MVP API.
 * This is a deployable starting point, not a claim of production readiness.
 * Requires a Node.js host that supports persistent disk storage for SQLite/uploads.
 */
import express from 'express';
import crypto from 'node:crypto';
import dotenv from 'dotenv';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import multer from 'multer';
import Database from 'better-sqlite3';

dotenv.config();
const app = express();
const PORT = Number(process.env.PORT || 3000);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const dataDir = path.resolve(process.env.DATA_DIR || path.join(rootDir, 'data'));
const uploadDir = path.join(dataDir, 'uploads');
fs.mkdirSync(uploadDir, { recursive: true });
const db = new Database(path.join(dataDir, 'carteenaclub.sqlite'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Database schema. Migrations are intentionally simple for this first MVP.
db.exec(`
CREATE TABLE IF NOT EXISTS users (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 username TEXT NOT NULL UNIQUE COLLATE NOCASE,
 email TEXT NOT NULL UNIQUE COLLATE NOCASE,
 password_hash TEXT NOT NULL,
 display_name TEXT NOT NULL,
 bio TEXT NOT NULL DEFAULT '',
 role TEXT NOT NULL DEFAULT 'user',
 coins INTEGER NOT NULL DEFAULT 0 CHECK(coins >= 0),
 premium_until TEXT,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS posts (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 body TEXT NOT NULL DEFAULT '',
 media_path TEXT,
 media_type TEXT,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS likes (
 user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY(user_id, post_id)
);
CREATE TABLE IF NOT EXISTS comments (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
 body TEXT NOT NULL,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS reports (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 reporter_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 post_id INTEGER REFERENCES posts(id) ON DELETE CASCADE,
 reported_user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
 reason TEXT NOT NULL,
 details TEXT NOT NULL DEFAULT '',
 status TEXT NOT NULL DEFAULT 'open',
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS payments (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 order_id TEXT NOT NULL UNIQUE,
 user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 package_id TEXT NOT NULL,
 amount REAL NOT NULL,
 price_currency TEXT NOT NULL DEFAULT 'usd',
 provider TEXT NOT NULL,
 provider_invoice_id TEXT,
 provider_payment_id TEXT,
 invoice_url TEXT,
 provider_status TEXT NOT NULL DEFAULT 'created',
 fulfilled_at TEXT,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS coin_ledger (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 delta INTEGER NOT NULL,
 reason TEXT NOT NULL,
 reference TEXT UNIQUE,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS ad_settings (
 id INTEGER PRIMARY KEY CHECK(id = 1),
 enabled INTEGER NOT NULL DEFAULT 1,
 network TEXT NOT NULL DEFAULT 'direct',
 publisher_id TEXT NOT NULL DEFAULT '',
 updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT OR IGNORE INTO ad_settings(id, enabled, network, publisher_id) VALUES(1, 1, 'direct', '');
CREATE TABLE IF NOT EXISTS gifts (
 id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, emoji TEXT NOT NULL DEFAULT '🎁', price INTEGER NOT NULL CHECK(price > 0),
 category TEXT NOT NULL DEFAULT 'Basic', enabled INTEGER NOT NULL DEFAULT 1, featured INTEGER NOT NULL DEFAULT 0,
 artwork_url TEXT NOT NULL DEFAULT '', start_date TEXT, end_date TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS gift_categories (
 id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE COLLATE NOCASE, description TEXT NOT NULL DEFAULT '', enabled INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS platform_settings (
 setting_key TEXT PRIMARY KEY, setting_value TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS staff_permissions (
 user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, staff_role TEXT NOT NULL,
 permissions_json TEXT NOT NULL DEFAULT '[]', limits_json TEXT NOT NULL DEFAULT '{}', enabled INTEGER NOT NULL DEFAULT 1,
 updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS admin_audit_log (
 id INTEGER PRIMARY KEY AUTOINCREMENT, actor_user_id INTEGER, action TEXT NOT NULL, target_type TEXT NOT NULL DEFAULT '', target_id TEXT NOT NULL DEFAULT '', details_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS payout_requests (
 id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 amount REAL NOT NULL CHECK(amount > 0), status TEXT NOT NULL DEFAULT 'pending', reason TEXT NOT NULL DEFAULT '',
 reviewed_by INTEGER, reviewed_at TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS creator_eligibility (
 user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
 followers INTEGER NOT NULL DEFAULT 0, live_hours_30d REAL NOT NULL DEFAULT 0, views_30d INTEGER NOT NULL DEFAULT 0, gifts_30d INTEGER NOT NULL DEFAULT 0,
 legal_age_confirmed INTEGER NOT NULL DEFAULT 0, payout_verified INTEGER NOT NULL DEFAULT 0, good_standing INTEGER NOT NULL DEFAULT 1,
 supported_country INTEGER NOT NULL DEFAULT 0, two_factor_enabled INTEGER NOT NULL DEFAULT 0, withdrawable_balance REAL NOT NULL DEFAULT 0,
 updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT OR IGNORE INTO gift_categories(name,description) VALUES ('Basic','Everyday gifts, low value'),('Premium','Popular gifts, medium value'),('Luxury','High value, special effects'),('Seasonal','Holiday and event gifts'),('Custom','Special or limited time');
INSERT OR IGNORE INTO platform_settings(setting_key,setting_value) VALUES
 ('gift_settings','{"creatorShare":70,"hostShare":10,"platformShare":20,"minGiftPrice":100,"maxGiftPrice":10000,"requireGiftApproval":true,"allowStaffGiftManagement":false}'),
 ('monetization_rules','{"minFollowers":1000,"minAccountAgeDays":30,"minLiveHours":10,"minViews":10000,"minPayout":50,"cooldownDays":7,"maxPayout":5000,"minGifts":25,"requireLegalAge":true,"requireVerification":true,"requireGoodStanding":true,"requireSupportedCountry":true,"require2FA":false,"manualApproval":true,"monetizationEnabled":true,"withdrawEnabled":true}');
`);

const seedGifts = [
 ['Rose','🌹',100,'Basic'],['Heart','💖',200,'Basic'],['Diamond','💎',500,'Premium'],['Crown','👑',1000,'Luxury'],['Sports Car','🏎️',2000,'Luxury'],['Fireworks','🎆',1500,'Premium'],['Chat Bubble','💬',300,'Basic'],['Music Note','🎵',400,'Basic'],['Panda','🐼',600,'Premium'],['Universe','🪐',1200,'Luxury'],['Rocket','🚀',1800,'Luxury'],['Golden Heart','🧡',2500,'Luxury']
];
if (db.prepare('SELECT COUNT(*) AS n FROM gifts').get().n === 0) {
 const addSeedGift = db.prepare('INSERT INTO gifts(name,emoji,price,category,enabled,featured) VALUES(?,?,?,?,1,0)');
 db.transaction(() => seedGifts.forEach(g => addSeedGift.run(...g)))();
}

const JWT_SECRET = process.env.JWT_SECRET;
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: 'draft-7', legacyHeaders: false, message: { error: 'Too many attempts. Please try again later.' } });
const apiLimiter = rateLimit({ windowMs: 60 * 1000, limit: 120, standardHeaders: 'draft-7', legacyHeaders: false });
app.disable('x-powered-by');
app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' }, contentSecurityPolicy: false }));
app.use('/api', apiLimiter);
// IPN route uses raw bytes for provider signature verification, so it must be registered before express.json().
app.post('/api/payments/nowpayments/ipn', express.raw({ type: 'application/json', limit: '256kb' }), handleNowPaymentsIPN);
app.use(express.json({ limit: '1mb' }));
app.use('/uploads', express.static(uploadDir, { maxAge: '7d', immutable: true }));
app.use(express.static(path.join(rootDir, 'public')));

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, uploadDir),
    filename: (_req, file, cb) => cb(null, `${crypto.randomUUID()}${path.extname(file.originalname).toLowerCase().slice(0, 10)}`)
  }),
  limits: { fileSize: Number(process.env.MAX_UPLOAD_MB || 40) * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    const allowed = new Set(['image/jpeg','image/png','image/webp','image/gif','video/mp4','video/webm','video/quicktime']);
    cb(allowed.has(file.mimetype) ? null : new Error('Only supported image and video files are allowed.'), allowed.has(file.mimetype));
  }
});

function apiError(res, status, message) { return res.status(status).json({ error: message }); }
function currentUser(req) {
  const header = req.get('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token || !JWT_SECRET) return null;
  try { return jwt.verify(token, JWT_SECRET); } catch { return null; }
}
function requireAuth(req, res, next) {
  const user = currentUser(req);
  if (!user) return apiError(res, 401, JWT_SECRET ? 'Please sign in to continue.' : 'Server authentication is not configured. Set JWT_SECRET.');
  req.user = user;
  next();
}
function staffCan(userId, permission) {
  const user = db.prepare('SELECT role FROM users WHERE id=?').get(userId);
  if (user?.role === 'admin') return true;
  const staff = db.prepare('SELECT enabled,permissions_json FROM staff_permissions WHERE user_id=?').get(userId);
  if (!staff || !staff.enabled) return false;
  try { return JSON.parse(staff.permissions_json).includes(permission); } catch { return false; }
}
function requirePermission(permission) {
  return (req,res,next) => staffCan(req.user.id, permission) ? next() : apiError(res,403,'You do not have permission to perform this action.');
}
function requireAdmin(req,res,next) {
  const user = db.prepare('SELECT id,role FROM users WHERE id=?').get(req.user.id);
  if (user?.role === 'admin') return next();
  return apiError(res,403,'Super Admin access required.');
}
function audit(actorId, action, targetType='', targetId='', details={}) {
  db.prepare('INSERT INTO admin_audit_log(actor_user_id,action,target_type,target_id,details_json) VALUES(?,?,?,?,?)')
    .run(actorId,action,targetType,String(targetId),JSON.stringify(details));
}
function getSetting(key, fallback={}) {
  const row=db.prepare('SELECT setting_value FROM platform_settings WHERE setting_key=?').get(key);
  if (!row) return fallback;
  try { return JSON.parse(row.setting_value); } catch { return fallback; }
}
function setSetting(key,value) {
  db.prepare('INSERT INTO platform_settings(setting_key,setting_value,updated_at) VALUES(?,?,CURRENT_TIMESTAMP) ON CONFLICT(setting_key) DO UPDATE SET setting_value=excluded.setting_value,updated_at=CURRENT_TIMESTAMP').run(key,JSON.stringify(value));
}
function publicUser(row) {
  return { id: row.id, username: row.username, displayName: row.display_name, bio: row.bio || '', role: row.role, coins: row.coins, premium: !!row.premium_until && new Date(row.premium_until) > new Date(), premiumUntil: row.premium_until, createdAt: row.created_at };
}
function issueToken(user) {
  if (!JWT_SECRET || JWT_SECRET.length < 32) throw new Error('JWT_SECRET must be configured with at least 32 characters.');
  return jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '7d', issuer: 'carteenaclub' });
}
function validateText(value, max) { return typeof value === 'string' && value.trim().length > 0 && value.trim().length <= max; }

app.get('/api/health', (_req, res) => res.json({ ok: true, service: 'carteenaclub-api', database: 'sqlite', timestamp: new Date().toISOString() }));
app.get('/api/config', (_req, res) => {
  const settings = db.prepare('SELECT enabled, network, publisher_id FROM ad_settings WHERE id=1').get();
  res.json({ brand: 'CARTEENACLUB', registrationEnabled: process.env.REGISTRATION_ENABLED !== 'false', adsEnabled: !!settings.enabled, adNetwork: settings.network, publisherId: settings.publisher_id || '', payments: { nowpaymentsConfigured: !!(process.env.NOWPAYMENTS_API_KEY && process.env.PUBLIC_BASE_URL), cardGooglePayConfigured: !!process.env.CARD_PAYMENT_CHECKOUT_URL }, features: { liveStreaming: false, persistentPosts: true, coinLedger: true } });
});

app.post('/api/auth/register', authLimiter, (req, res) => {
  try {
    if (process.env.REGISTRATION_ENABLED === 'false') return apiError(res, 403, 'Registration is temporarily closed.');
    if (!JWT_SECRET || JWT_SECRET.length < 32) return apiError(res, 503, 'Authentication setup is incomplete. The administrator must configure JWT_SECRET.');
    const { username, email, password, displayName } = req.body || {};
    const cleanUsername = String(username || '').trim().replace(/^@/, '');
    const cleanEmail = String(email || '').trim().toLowerCase();
    const cleanDisplay = String(displayName || cleanUsername).trim().slice(0, 60);
    if (!/^[a-zA-Z0-9_]{3,24}$/.test(cleanUsername)) return apiError(res, 400, 'Username must be 3–24 letters, numbers or underscores.');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail) || cleanEmail.length > 254) return apiError(res, 400, 'Enter a valid email address.');
    if (typeof password !== 'string' || password.length < 10 || password.length > 128) return apiError(res, 400, 'Password must be between 10 and 128 characters.');
    if (!cleanDisplay) return apiError(res, 400, 'Enter a display name.');
    if (db.prepare('SELECT id FROM users WHERE username = ? OR email = ?').get(cleanUsername, cleanEmail)) return apiError(res, 409, 'That username or email is already registered.');
    const hash = bcrypt.hashSync(password, 12);
    const role = process.env.ADMIN_EMAIL && cleanEmail === process.env.ADMIN_EMAIL.toLowerCase() ? 'admin' : 'user';
    const result = db.prepare('INSERT INTO users(username,email,password_hash,display_name,role) VALUES(?,?,?,?,?)').run(cleanUsername, cleanEmail, hash, cleanDisplay, role);
    const user = db.prepare('SELECT * FROM users WHERE id=?').get(result.lastInsertRowid);
    return res.status(201).json({ token: issueToken(user), user: publicUser(user) });
  } catch (err) { console.error('Register error:', err.message); return apiError(res, 500, 'Could not create your account.'); }
});

app.post('/api/auth/login', authLimiter, (req, res) => {
  try {
    if (!JWT_SECRET || JWT_SECRET.length < 32) return apiError(res, 503, 'Authentication setup is incomplete.');
    const identity = String(req.body?.identity || '').trim();
    const password = req.body?.password;
    const user = db.prepare('SELECT * FROM users WHERE email = ? COLLATE NOCASE OR username = ? COLLATE NOCASE').get(identity, identity.replace(/^@/, ''));
    if (!user || typeof password !== 'string' || !bcrypt.compareSync(password, user.password_hash)) return apiError(res, 401, 'Email/username or password is incorrect.');
    return res.json({ token: issueToken(user), user: publicUser(user) });
  } catch (err) { console.error('Login error:', err.message); return apiError(res, 500, 'Could not sign in.'); }
});
app.get('/api/auth/me', requireAuth, (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id);
  if (!user) return apiError(res, 401, 'Account no longer exists.');
  res.json({ user: publicUser(user) });
});
app.patch('/api/profile', requireAuth, (req, res) => {
  const displayName = String(req.body?.displayName || '').trim();
  const bio = String(req.body?.bio || '').trim();
  if (!displayName || displayName.length > 60 || bio.length > 240) return apiError(res, 400, 'Display name is required (up to 60 characters); bio may be up to 240 characters.');
  db.prepare('UPDATE users SET display_name=?, bio=? WHERE id=?').run(displayName, bio, req.user.id);
  res.json({ user: publicUser(db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id)) });
});

app.get('/api/posts', (req, res) => {
  const limit = Math.min(50, Math.max(1, Number.parseInt(req.query.limit || '20', 10) || 20));
  const before = Number.parseInt(req.query.before || '0', 10) || Number.MAX_SAFE_INTEGER;
  const viewer = currentUser(req);
  const rows = db.prepare(`SELECT p.id,p.body,p.media_path,p.media_type,p.created_at,u.id AS author_id,u.username,u.display_name,
    (SELECT COUNT(*) FROM likes l WHERE l.post_id=p.id) AS like_count,
    (SELECT COUNT(*) FROM comments c WHERE c.post_id=p.id) AS comment_count,
    ${viewer ? '(SELECT COUNT(*) FROM likes vl WHERE vl.post_id=p.id AND vl.user_id=? )' : '0'} AS viewer_liked
    FROM posts p JOIN users u ON u.id=p.user_id WHERE p.id < ? ORDER BY p.id DESC LIMIT ?`).all(...(viewer ? [viewer.id, before, limit] : [before, limit]));
  res.json({ posts: rows.map(p => ({ id:p.id, body:p.body, mediaUrl:p.media_path, mediaType:p.media_type, createdAt:p.created_at, author:{id:p.author_id,username:p.username,displayName:p.display_name}, likes:p.like_count, comments:p.comment_count, liked:!!p.viewer_liked })) });
});
app.post('/api/posts', requireAuth, upload.single('media'), (req, res) => {
  const body = String(req.body?.body || '').trim();
  if (body.length > 3000) { if(req.file) fs.unlinkSync(req.file.path); return apiError(res, 400, 'Post text must be 3,000 characters or fewer.'); }
  if (!body && !req.file) return apiError(res, 400, 'Write something or attach a photo/video.');
  const mediaPath = req.file ? `/uploads/${path.basename(req.file.path)}` : null;
  const result = db.prepare('INSERT INTO posts(user_id,body,media_path,media_type) VALUES(?,?,?,?)').run(req.user.id, body, mediaPath, req.file?.mimetype || null);
  const post = db.prepare(`SELECT p.id,p.body,p.media_path,p.media_type,p.created_at,u.id AS author_id,u.username,u.display_name FROM posts p JOIN users u ON u.id=p.user_id WHERE p.id=?`).get(result.lastInsertRowid);
  res.status(201).json({ post: { id:post.id, body:post.body, mediaUrl:post.media_path, mediaType:post.media_type, createdAt:post.created_at, author:{id:post.author_id,username:post.username,displayName:post.display_name}, likes:0, comments:0, liked:false } });
});
app.delete('/api/posts/:id', requireAuth, (req, res) => {
  const post = db.prepare('SELECT id,user_id,media_path FROM posts WHERE id=?').get(Number(req.params.id));
  if (!post) return apiError(res, 404, 'Post not found.');
  const me = db.prepare('SELECT role FROM users WHERE id=?').get(req.user.id);
  if (post.user_id !== req.user.id && me?.role !== 'admin') return apiError(res, 403, 'You can only delete your own posts.');
  db.prepare('DELETE FROM posts WHERE id=?').run(post.id);
  if (post.media_path) { const filePath = path.join(uploadDir, path.basename(post.media_path)); if (fs.existsSync(filePath)) fs.unlinkSync(filePath); }
  res.json({ ok:true });
});
app.post('/api/posts/:id/like', requireAuth, (req, res) => {
  const postId = Number(req.params.id);
  if (!db.prepare('SELECT id FROM posts WHERE id=?').get(postId)) return apiError(res, 404, 'Post not found.');
  const existing = db.prepare('SELECT 1 FROM likes WHERE user_id=? AND post_id=?').get(req.user.id, postId);
  if (existing) db.prepare('DELETE FROM likes WHERE user_id=? AND post_id=?').run(req.user.id, postId);
  else db.prepare('INSERT INTO likes(user_id,post_id) VALUES(?,?)').run(req.user.id, postId);
  const count = db.prepare('SELECT COUNT(*) AS n FROM likes WHERE post_id=?').get(postId).n;
  res.json({ liked:!existing, likes:count });
});
app.get('/api/posts/:id/comments', (req, res) => {
  const postId = Number(req.params.id);
  const rows = db.prepare('SELECT c.id,c.body,c.created_at,u.username,u.display_name FROM comments c JOIN users u ON u.id=c.user_id WHERE c.post_id=? ORDER BY c.id ASC LIMIT 100').all(postId);
  res.json({ comments: rows.map(c=>({id:c.id,body:c.body,createdAt:c.created_at,author:{username:c.username,displayName:c.display_name}})) });
});
app.post('/api/posts/:id/comments', requireAuth, (req, res) => {
  const postId = Number(req.params.id), body = String(req.body?.body || '').trim();
  if (!db.prepare('SELECT id FROM posts WHERE id=?').get(postId)) return apiError(res, 404, 'Post not found.');
  if (!validateText(body, 1000)) return apiError(res, 400, 'Comment must be 1–1,000 characters.');
  const result = db.prepare('INSERT INTO comments(user_id,post_id,body) VALUES(?,?,?)').run(req.user.id,postId,body);
  res.status(201).json({ id:result.lastInsertRowid, body, author:db.prepare('SELECT username,display_name FROM users WHERE id=?').get(req.user.id) });
});
app.post('/api/reports', requireAuth, (req, res) => {
  const postId = req.body?.postId ? Number(req.body.postId) : null;
  const reportedUserId = req.body?.reportedUserId ? Number(req.body.reportedUserId) : null;
  const reason = String(req.body?.reason || '').trim();
  const details = String(req.body?.details || '').trim().slice(0,1000);
  if (!validateText(reason, 80)) return apiError(res, 400, 'Choose a report reason.');
  if (!postId && !reportedUserId) return apiError(res, 400, 'Report a post or user.');
  db.prepare('INSERT INTO reports(reporter_id,post_id,reported_user_id,reason,details) VALUES(?,?,?,?,?)').run(req.user.id,postId,reportedUserId,reason,details);
  res.status(201).json({ ok:true, message:'Report received for moderator review.' });
});

const packages = {
  coins_1000: { amount: 2.99, description: 'CARTEENACLUB 1,000 coin package', coins: 1000 },
  coins_5500: { amount: 14.99, description: 'CARTEENACLUB 5,500 coin package', coins: 5500 },
  coins_12000: { amount: 29.99, description: 'CARTEENACLUB 12,000 coin package', coins: 12000 },
  premium_monthly: { amount: 4.99, description: 'CARTEENACLUB Premium monthly subscription', premium: true }
};
app.get('/api/wallet', requireAuth, (req, res) => {
  const user = db.prepare('SELECT coins,premium_until FROM users WHERE id=?').get(req.user.id);
  const ledger = db.prepare('SELECT delta,reason,created_at FROM coin_ledger WHERE user_id=? ORDER BY id DESC LIMIT 30').all(req.user.id);
  res.json({ coins:user.coins, premium:!!user.premium_until && new Date(user.premium_until)>new Date(), premiumUntil:user.premium_until, ledger });
});
app.post('/api/payments/nowpayments/invoice', requireAuth, async (req, res) => {
  try {
    const apiKey = process.env.NOWPAYMENTS_API_KEY, baseUrl = process.env.PUBLIC_BASE_URL;
    if (!apiKey || !baseUrl) return apiError(res, 503, 'NOWPayments is not configured yet.');
    const item = packages[String(req.body?.packageId || '')];
    if (!item) return apiError(res, 400, 'Unknown package.');
    const orderId = `cc_${crypto.randomUUID()}`;
    const providerResponse = await fetch('https://api.nowpayments.io/v1/invoice', {
      method:'POST', headers:{'x-api-key':apiKey,'Content-Type':'application/json'},
      body:JSON.stringify({ price_amount:item.amount, price_currency:'usd', order_id:orderId, order_description:item.description, ipn_callback_url:`${baseUrl}/api/payments/nowpayments/ipn`, success_url:`${baseUrl}/?payment=return&status=success`, cancel_url:`${baseUrl}/?payment=return&status=cancelled` })
    });
    const data = await providerResponse.json();
    if (!providerResponse.ok || !data.invoice_url || !data.id) { console.error('NOWPayments create invoice failed:', data); return apiError(res, 502, 'Payment provider could not create an invoice.'); }
    db.prepare('INSERT INTO payments(order_id,user_id,package_id,amount,provider,provider_invoice_id,invoice_url) VALUES(?,?,?,?,?,?,?)').run(orderId,req.user.id,req.body.packageId,item.amount,'nowpayments',String(data.id),data.invoice_url);
    res.status(201).json({ orderId, invoiceUrl:data.invoice_url, invoiceId:data.id });
  } catch (err) { console.error('NOWPayments invoice error:', err.message); apiError(res, 500, 'Could not create payment invoice.'); }
});
app.get('/api/payments/:orderId', requireAuth, (req, res) => {
  const p = db.prepare('SELECT order_id,package_id,amount,provider_status,fulfilled_at,created_at FROM payments WHERE order_id=? AND user_id=?').get(String(req.params.orderId),req.user.id);
  if (!p) return apiError(res,404,'Payment not found.');
  res.json({ payment:{orderId:p.order_id,packageId:p.package_id,amount:p.amount,status:p.provider_status,fulfilled:!!p.fulfilled_at,createdAt:p.created_at} });
});
async function handleNowPaymentsIPN(req, res) {
  const secret = process.env.NOWPAYMENTS_IPN_SECRET;
  if (!secret) return res.status(503).send('IPN secret is not configured');
  let payload;
  try { payload = JSON.parse(req.body.toString('utf8')); } catch { return res.status(400).send('Invalid JSON'); }
  const received = req.get('x-nowpayments-sig') || '';
  const expected = crypto.createHmac('sha512', secret).update(JSON.stringify(sortObject(payload))).digest('hex');
  if (!safeEqual(received, expected)) return res.status(401).send('Invalid signature');
  const orderId = String(payload.order_id || '');
  const payment = db.prepare('SELECT * FROM payments WHERE order_id=? AND provider="nowpayments"').get(orderId);
  if (!payment) return res.status(404).send('Unknown order');
  if (payment.fulfilled_at) return res.status(200).send('Already fulfilled');
  const status = String(payload.payment_status || 'unknown');
  db.prepare('UPDATE payments SET provider_status=?, provider_payment_id=COALESCE(?,provider_payment_id) WHERE order_id=?').run(status,payload.payment_id ? String(payload.payment_id) : null,orderId);
  if (status === 'finished') {
    // Cross-check provider amount against the fixed server-side order amount before granting anything.
    const receivedAmount = Number(payload.price_amount);
    const receivedCurrency = String(payload.price_currency || '').toLowerCase();
    if (!Number.isFinite(receivedAmount) || Math.abs(receivedAmount - payment.amount) > 0.02 || receivedCurrency !== 'usd') {
      console.error('Payment reconciliation mismatch for order', orderId);
      return res.status(400).send('Payment amount/currency mismatch');
    }
    const item = packages[payment.package_id];
    if (!item) return res.status(400).send('Unknown package');
    const fulfill = db.transaction(() => {
      const fresh = db.prepare('SELECT fulfilled_at FROM payments WHERE order_id=?').get(orderId);
      if (fresh?.fulfilled_at) return;
      if (item.coins) {
        db.prepare('UPDATE users SET coins=coins+? WHERE id=?').run(item.coins,payment.user_id);
        db.prepare('INSERT OR IGNORE INTO coin_ledger(user_id,delta,reason,reference) VALUES(?,?,?,?)').run(payment.user_id,item.coins,`Purchased ${item.coins} coins`,orderId);
      }
      if (item.premium) {
        const row = db.prepare('SELECT premium_until FROM users WHERE id=?').get(payment.user_id);
        const current = row?.premium_until && new Date(row.premium_until)>new Date() ? new Date(row.premium_until) : new Date();
        current.setMonth(current.getMonth()+1);
        db.prepare('UPDATE users SET premium_until=? WHERE id=?').run(current.toISOString(),payment.user_id);
      }
      db.prepare('UPDATE payments SET fulfilled_at=CURRENT_TIMESTAMP WHERE order_id=? AND fulfilled_at IS NULL').run(orderId);
    });
    fulfill();
  }
  return res.status(200).send('OK');
}

// Gift catalogue, monetization rules, staff permissions and payout request controls.
app.get('/api/gifts', (_req,res) => {
 const gifts=db.prepare('SELECT * FROM gifts WHERE enabled=1 AND (start_date IS NULL OR start_date<=date(\'now\')) AND (end_date IS NULL OR end_date>=date(\'now\')) ORDER BY featured DESC,price ASC').all();
 res.json({gifts:gifts.map(g=>({...g,enabled:!!g.enabled,featured:!!g.featured}))});
});
app.get('/api/admin/gifts', requireAuth, requirePermission('gifts.view'), (_req,res) => {
 const gifts=db.prepare('SELECT * FROM gifts ORDER BY id DESC').all();
 const categories=db.prepare('SELECT * FROM gift_categories ORDER BY name').all();
 res.json({gifts:gifts.map(g=>({...g,enabled:!!g.enabled,featured:!!g.featured})),categories,settings:getSetting('gift_settings')});
});
app.post('/api/admin/gifts/artwork', requireAuth, requirePermission('gifts.manage'), upload.single('media'), (req,res) => {
 if(!req.file)return apiError(res,400,'Choose a supported image or video file.');
 const url='/uploads/'+path.basename(req.file.path);audit(req.user.id,'gift-artwork.upload','asset',path.basename(req.file.path),{mimetype:req.file.mimetype,size:req.file.size});
 res.status(201).json({artworkUrl:url,mimeType:req.file.mimetype});
});
app.post('/api/admin/gifts', requireAuth, requirePermission('gifts.manage'), (req,res) => {
 const b=req.body||{}, name=String(b.name||'').trim().slice(0,40), emoji=String(b.emoji||'🎁').trim().slice(0,100), category=String(b.category||'Basic').trim().slice(0,40), price=Number(b.price);
 const settings=getSetting('gift_settings');
 if(!name || !Number.isInteger(price) || price<Number(settings.minGiftPrice||1) || price>Number(settings.maxGiftPrice||10000000)) return apiError(res,400,'Enter a name and a coin price within the configured range.');
 if(!db.prepare('SELECT id FROM gift_categories WHERE name=? COLLATE NOCASE').get(category)) return apiError(res,400,'Choose an existing gift category.');
 const id=Number(b.id||0), fields=[name,emoji,price,category,b.enabled===false?0:1,b.featured?1:0,String(b.artworkUrl||'').slice(0,1000),b.startDate||null,b.endDate||null];
 let giftId;
 if(id){ const r=db.prepare('UPDATE gifts SET name=?,emoji=?,price=?,category=?,enabled=?,featured=?,artwork_url=?,start_date=?,end_date=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(...fields,id); if(!r.changes)return apiError(res,404,'Gift not found.'); giftId=id; audit(req.user.id,'gift.update','gift',id,{name,price,category}); }
 else { const r=db.prepare('INSERT INTO gifts(name,emoji,price,category,enabled,featured,artwork_url,start_date,end_date) VALUES(?,?,?,?,?,?,?,?,?)').run(...fields); giftId=Number(r.lastInsertRowid); audit(req.user.id,'gift.create','gift',giftId,{name,price,category}); }
 res.status(id?200:201).json({gift:db.prepare('SELECT * FROM gifts WHERE id=?').get(giftId)});
});
app.patch('/api/admin/gifts/:id', requireAuth, requirePermission('gifts.manage'), (req,res) => {
 const g=db.prepare('SELECT * FROM gifts WHERE id=?').get(Number(req.params.id)); if(!g)return apiError(res,404,'Gift not found.');
 const enabled=req.body?.enabled===undefined?g.enabled:(req.body.enabled?1:0), featured=req.body?.featured===undefined?g.featured:(req.body.featured?1:0);
 db.prepare('UPDATE gifts SET enabled=?,featured=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(enabled,featured,g.id); audit(req.user.id,'gift.toggle','gift',g.id,{enabled:!!enabled,featured:!!featured});
 res.json({gift:db.prepare('SELECT * FROM gifts WHERE id=?').get(g.id)});
});
app.delete('/api/admin/gifts/:id', requireAuth, requirePermission('gifts.manage'), (req,res) => {
 const id=Number(req.params.id), g=db.prepare('SELECT name FROM gifts WHERE id=?').get(id); if(!g)return apiError(res,404,'Gift not found.');
 db.prepare('DELETE FROM gifts WHERE id=?').run(id); audit(req.user.id,'gift.delete','gift',id,{name:g.name}); res.json({ok:true});
});
app.post('/api/admin/gift-categories', requireAuth, requirePermission('gifts.manage'), (req,res) => {
 const name=String(req.body?.name||'').trim().slice(0,40); if(!name)return apiError(res,400,'Category name is required.');
 try { const r=db.prepare('INSERT INTO gift_categories(name,description) VALUES(?,?)').run(name,String(req.body?.description||'').slice(0,160)); audit(req.user.id,'gift-category.create','category',r.lastInsertRowid,{name}); res.status(201).json({category:db.prepare('SELECT * FROM gift_categories WHERE id=?').get(r.lastInsertRowid)}); }
 catch { return apiError(res,409,'That category already exists.'); }
});
app.get('/api/admin/monetization', requireAuth, requirePermission('monetization.view'), (_req,res)=>res.json({rules:getSetting('monetization_rules')}));
app.patch('/api/admin/monetization', requireAuth, requirePermission('monetization.manage'), (req,res)=>{
 const old=getSetting('monetization_rules'), allowed=['minFollowers','minAccountAgeDays','minLiveHours','minViews','minPayout','cooldownDays','maxPayout','minGifts']; const next={...old};
 for(const k of allowed){ if(req.body?.[k]!==undefined){const n=Number(req.body[k]); if(!Number.isFinite(n)||n<0)return apiError(res,400,`Invalid ${k}.`); next[k]=n;}}
 if(next.minPayout<1||next.maxPayout<next.minPayout)return apiError(res,400,'Maximum payout must be at least the minimum payout.');
 for(const k of ['requireLegalAge','requireVerification','requireGoodStanding','requireSupportedCountry','require2FA','manualApproval','monetizationEnabled','withdrawEnabled']) if(req.body?.[k]!==undefined)next[k]=!!req.body[k];
 setSetting('monetization_rules',next); audit(req.user.id,'monetization.update','settings','monetization_rules',next); res.json({rules:next});
});
app.get('/api/admin/gift-settings', requireAuth, requirePermission('gifts.view'), (_req,res)=>res.json({settings:getSetting('gift_settings')}));
app.patch('/api/admin/gift-settings', requireAuth, requirePermission('gifts.manage'), (req,res)=>{
 const old=getSetting('gift_settings'), next={...old};
 for(const k of ['creatorShare','hostShare','platformShare','minGiftPrice','maxGiftPrice']) if(req.body?.[k]!==undefined){const n=Number(req.body[k]);if(!Number.isFinite(n)||n<0)return apiError(res,400,`Invalid ${k}.`);next[k]=n;}
 for(const k of ['requireGiftApproval','allowStaffGiftManagement'])if(req.body?.[k]!==undefined)next[k]=!!req.body[k];
 if(next.creatorShare+next.hostShare+next.platformShare!==100)return apiError(res,400,'Creator, host and platform shares must total exactly 100%.');
 if(next.minGiftPrice<1||next.maxGiftPrice<next.minGiftPrice)return apiError(res,400,'Invalid gift price range.');
 setSetting('gift_settings',next); audit(req.user.id,'gift-settings.update','settings','gift_settings',next);res.json({settings:next});
});
app.get('/api/admin/staff', requireAuth, requireAdmin, (_req,res)=>{
 const rows=db.prepare(`SELECT u.id,u.username,u.email,u.display_name,u.role,sp.staff_role,sp.permissions_json,sp.limits_json,sp.enabled FROM users u LEFT JOIN staff_permissions sp ON sp.user_id=u.id WHERE u.role!='admin' AND sp.user_id IS NOT NULL ORDER BY u.id DESC`).all();
 res.json({staff:rows.map(x=>({...x,permissions:JSON.parse(x.permissions_json||'[]'),limits:JSON.parse(x.limits_json||'{}'),enabled:!!x.enabled}))});
});
app.post('/api/admin/staff', requireAuth, requireAdmin, (req,res)=>{
 const email=String(req.body?.email||'').trim().toLowerCase(), role=String(req.body?.role||'');
 const allowedRoles=['finance_staff','moderator','advertising_manager','custom'];
 if(!allowedRoles.includes(role))return apiError(res,400,'Choose a permitted staff role.');
 const target=db.prepare('SELECT id,role FROM users WHERE email=? COLLATE NOCASE').get(email);if(!target)return apiError(res,404,'Register this staff member first, then assign their role.');if(target.role==='admin')return apiError(res,400,'The Super Admin account cannot be changed here.');
 const allowedPermissions=['gifts.view','gifts.manage','monetization.view','monetization.manage','staff.manage','reports.view','reports.manage','live.safety','finance.view','finance.adjust','payouts.review','ads.view','ads.manage','audit.view'];
 const permissions=Array.isArray(req.body?.permissions)?[...new Set(req.body.permissions.filter(p=>allowedPermissions.includes(p)))]:[];
 const limits=req.body?.limits&&typeof req.body.limits==='object'?req.body.limits:{};
 db.prepare(`INSERT INTO staff_permissions(user_id,staff_role,permissions_json,limits_json,enabled,updated_at) VALUES(?,?,?,?,1,CURRENT_TIMESTAMP) ON CONFLICT(user_id) DO UPDATE SET staff_role=excluded.staff_role,permissions_json=excluded.permissions_json,limits_json=excluded.limits_json,enabled=1,updated_at=CURRENT_TIMESTAMP`).run(target.id,role,JSON.stringify(permissions),JSON.stringify(limits));
 audit(req.user.id,'staff.permissions.update','user',target.id,{role,permissions,limits});res.json({ok:true,userId:target.id,role,permissions,limits});
});
app.patch('/api/admin/staff/:id', requireAuth, requireAdmin, (req,res)=>{
 const id=Number(req.params.id), row=db.prepare('SELECT * FROM staff_permissions WHERE user_id=?').get(id);if(!row)return apiError(res,404,'Staff record not found.');
 const enabled=req.body?.enabled===undefined?row.enabled:(req.body.enabled?1:0), allowedPermissions=['gifts.view','gifts.manage','monetization.view','monetization.manage','staff.manage','reports.view','reports.manage','live.safety','finance.view','finance.adjust','payouts.review','ads.view','ads.manage','audit.view'];
 const permissions=Array.isArray(req.body?.permissions)?[...new Set(req.body.permissions.filter(p=>allowedPermissions.includes(p)))]:JSON.parse(row.permissions_json);
 db.prepare('UPDATE staff_permissions SET enabled=?,permissions_json=?,updated_at=CURRENT_TIMESTAMP WHERE user_id=?').run(enabled,JSON.stringify(permissions),id);audit(req.user.id,'staff.permissions.update','user',id,{enabled:!!enabled,permissions});res.json({ok:true});
});
app.post('/api/admin/users/:id/coins', requireAuth, requirePermission('finance.adjust'), (req,res)=>{
 const userId=Number(req.params.id), delta=Number(req.body?.delta), reason=String(req.body?.reason||'').trim().slice(0,200);
 if(!Number.isInteger(userId)||!Number.isInteger(delta)||delta===0||Math.abs(delta)>100000000||!reason)return apiError(res,400,'Provide a user ID, a non-zero whole coin amount, and a reason.');
 const target=db.prepare('SELECT id,coins FROM users WHERE id=?').get(userId);if(!target)return apiError(res,404,'User not found.');
 const actor=db.prepare('SELECT role FROM users WHERE id=?').get(req.user.id);
 if(actor?.role!=='admin') { const staff=db.prepare('SELECT limits_json FROM staff_permissions WHERE user_id=? AND enabled=1').get(req.user.id);let limits={};try{limits=JSON.parse(staff?.limits_json||'{}')}catch{} if(Number.isFinite(Number(limits.maxCoinAdjustment))&&Math.abs(delta)>Number(limits.maxCoinAdjustment))return apiError(res,403,'This adjustment exceeds your assigned coin limit.'); }
 if(target.coins+delta<0)return apiError(res,400,'The adjustment would make the coin balance negative.');
 const ref='admin_coin_'+crypto.randomUUID();const tx=db.transaction(()=>{db.prepare('UPDATE users SET coins=coins+? WHERE id=?').run(delta,userId);db.prepare('INSERT INTO coin_ledger(user_id,delta,reason,reference) VALUES(?,?,?,?)').run(userId,delta,reason,ref);audit(req.user.id,'coins.adjust','user',userId,{delta,reason,reference:ref});});tx();res.json({ok:true,userId,coins:db.prepare('SELECT coins FROM users WHERE id=?').get(userId).coins,delta,reference:ref});
});
app.get('/api/admin/audit', requireAuth, requirePermission('audit.view'), (_req,res)=>res.json({events:db.prepare('SELECT a.*,u.username AS actor FROM admin_audit_log a LEFT JOIN users u ON u.id=a.actor_user_id ORDER BY a.id DESC LIMIT 250').all()}));
app.get('/api/admin/payout-requests', requireAuth, requirePermission('payouts.review'), (_req,res)=>res.json({requests:db.prepare('SELECT p.*,u.username,u.email FROM payout_requests p JOIN users u ON u.id=p.user_id ORDER BY p.id DESC LIMIT 250').all()}));
app.patch('/api/admin/payout-requests/:id', requireAuth, requirePermission('payouts.review'), (req,res)=>{
 const status=String(req.body?.status||'');if(!['approved','rejected','paid','pending'].includes(status))return apiError(res,400,'Invalid payout status.');
 const r=db.prepare('UPDATE payout_requests SET status=?,reviewed_by=?,reviewed_at=CURRENT_TIMESTAMP WHERE id=?').run(status,req.user.id,Number(req.params.id));if(!r.changes)return apiError(res,404,'Payout request not found.');audit(req.user.id,'payout.review','payout_request',req.params.id,{status});res.json({ok:true});
});
app.get('/api/monetization/eligibility', requireAuth, (req,res)=>{
 const rules=getSetting('monetization_rules'), m=db.prepare('SELECT * FROM creator_eligibility WHERE user_id=?').get(req.user.id), user=db.prepare('SELECT created_at FROM users WHERE id=?').get(req.user.id);
 const ageDays=(Date.now()-new Date(user.created_at+'Z').getTime())/86400000, checks={};
 checks.enabled=!!rules.monetizationEnabled && !!rules.withdrawEnabled; checks.accountAge=ageDays>=Number(rules.minAccountAgeDays||0);
 checks.followers=!!m && m.followers>=Number(rules.minFollowers||0); checks.liveHours=!!m && m.live_hours_30d>=Number(rules.minLiveHours||0); checks.views=!!m && m.views_30d>=Number(rules.minViews||0); checks.gifts=!!m && m.gifts_30d>=Number(rules.minGifts||0); checks.balance=!!m && m.withdrawable_balance>=Number(rules.minPayout||0);
 checks.legalAge=!rules.requireLegalAge || !!m?.legal_age_confirmed; checks.verification=!rules.requireVerification || !!m?.payout_verified; checks.goodStanding=!rules.requireGoodStanding || !!m?.good_standing; checks.country=!rules.requireSupportedCountry || !!m?.supported_country; checks.twoFactor=!rules.require2FA || !!m?.two_factor_enabled;
 res.json({eligible:Object.values(checks).every(Boolean),checks,metrics:m||null,required:rules});
});
app.post('/api/monetization/withdrawal-request', requireAuth, (req,res)=>{
 const rules=getSetting('monetization_rules');if(!rules.withdrawEnabled||!rules.monetizationEnabled)return apiError(res,403,'Creator monetization or withdrawals are currently disabled.');
 const amount=Number(req.body?.amount);if(!Number.isFinite(amount)||amount<rules.minPayout||amount>rules.maxPayout)return apiError(res,400,'Requested amount is outside the configured payout range.');
 const user=db.prepare('SELECT id,created_at FROM users WHERE id=?').get(req.user.id);const ageDays=(Date.now()-new Date(user.created_at+'Z').getTime())/86400000, m=db.prepare('SELECT * FROM creator_eligibility WHERE user_id=?').get(req.user.id);
 const reasons=[]; if(ageDays<Number(rules.minAccountAgeDays||0))reasons.push('account age');
 if(!m || m.followers<Number(rules.minFollowers||0))reasons.push('followers'); if(!m || m.live_hours_30d<Number(rules.minLiveHours||0))reasons.push('LIVE hours'); if(!m || m.views_30d<Number(rules.minViews||0))reasons.push('views'); if(!m || m.gifts_30d<Number(rules.minGifts||0))reasons.push('completed gifts'); if(!m || m.withdrawable_balance<amount || m.withdrawable_balance<Number(rules.minPayout||0))reasons.push('withdrawable balance');
 if(rules.requireLegalAge && !m?.legal_age_confirmed)reasons.push('legal age confirmation'); if(rules.requireVerification && !m?.payout_verified)reasons.push('payout verification'); if(rules.requireGoodStanding && !m?.good_standing)reasons.push('good standing'); if(rules.requireSupportedCountry && !m?.supported_country)reasons.push('supported payout country'); if(rules.require2FA && !m?.two_factor_enabled)reasons.push('two-factor authentication');
 if(reasons.length)return apiError(res,403,'You are not yet eligible to request a withdrawal. Requirements not met: '+reasons.join(', ')+'.');
 const pending=db.prepare('SELECT id FROM payout_requests WHERE user_id=? AND status IN (\'pending\',\'approved\')').get(req.user.id);if(pending)return apiError(res,409,'You already have a payout request awaiting completion.');
 const last=db.prepare('SELECT created_at FROM payout_requests WHERE user_id=? ORDER BY id DESC LIMIT 1').get(req.user.id);if(last&&Date.now()-new Date(last.created_at+'Z').getTime()<Number(rules.cooldownDays||0)*86400000)return apiError(res,429,'Please wait until your payout-request cooldown has passed.');
 const r=db.prepare('INSERT INTO payout_requests(user_id,amount,reason) VALUES(?,?,?)').run(req.user.id,amount,'Creator withdrawal request');audit(req.user.id,'payout.request','payout_request',r.lastInsertRowid,{amount});res.status(201).json({ok:true,id:r.lastInsertRowid,status:'pending',message:'Request submitted for review. Approval and actual payment are separate steps.'});
});
app.patch('/api/admin/creator-eligibility/:userId', requireAuth, requirePermission('monetization.manage'), (req,res)=>{
 const userId=Number(req.params.userId);if(!db.prepare('SELECT id FROM users WHERE id=?').get(userId))return apiError(res,404,'User not found.');
 const keys={followers:'followers',liveHours30d:'live_hours_30d',views30d:'views_30d',gifts30d:'gifts_30d',legalAgeConfirmed:'legal_age_confirmed',payoutVerified:'payout_verified',goodStanding:'good_standing',supportedCountry:'supported_country',twoFactorEnabled:'two_factor_enabled',withdrawableBalance:'withdrawable_balance'};
 const prior=db.prepare('SELECT * FROM creator_eligibility WHERE user_id=?').get(userId)||{};const vals={};for(const [key,col] of Object.entries(keys)){let v=req.body?.[key]===undefined?prior[col]:req.body[key];if(v===undefined)v=['legal_age_confirmed','payout_verified','supported_country','two_factor_enabled'].includes(col)?0:col==='good_standing'?1:0;if(col.endsWith('_confirmed')||['payout_verified','good_standing','supported_country','two_factor_enabled'].includes(col))v=v?1:0;else {v=Number(v);if(!Number.isFinite(v)||v<0)return apiError(res,400,`Invalid ${key}.`);}vals[col]=v;}
 db.prepare(`INSERT INTO creator_eligibility(user_id,followers,live_hours_30d,views_30d,gifts_30d,legal_age_confirmed,payout_verified,good_standing,supported_country,two_factor_enabled,withdrawable_balance,updated_at) VALUES(@user_id,@followers,@live_hours_30d,@views_30d,@gifts_30d,@legal_age_confirmed,@payout_verified,@good_standing,@supported_country,@two_factor_enabled,@withdrawable_balance,CURRENT_TIMESTAMP) ON CONFLICT(user_id) DO UPDATE SET followers=excluded.followers,live_hours_30d=excluded.live_hours_30d,views_30d=excluded.views_30d,gifts_30d=excluded.gifts_30d,legal_age_confirmed=excluded.legal_age_confirmed,payout_verified=excluded.payout_verified,good_standing=excluded.good_standing,supported_country=excluded.supported_country,two_factor_enabled=excluded.two_factor_enabled,withdrawable_balance=excluded.withdrawable_balance,updated_at=CURRENT_TIMESTAMP`).run({user_id:userId,...vals});audit(req.user.id,'creator-eligibility.update','user',userId,vals);res.json({ok:true,userId,metrics:vals});
});

// Admin controls: set ADMIN_EMAIL before registering that email to grant the initial admin role.
app.get('/api/admin/overview', requireAuth, requireAdmin, (_req,res) => {
  res.json({ users:db.prepare('SELECT COUNT(*) AS n FROM users').get().n, posts:db.prepare('SELECT COUNT(*) AS n FROM posts').get().n, openReports:db.prepare('SELECT COUNT(*) AS n FROM reports WHERE status="open"').get().n, payments:db.prepare('SELECT COUNT(*) AS n FROM payments').get().n, paidRevenue:db.prepare('SELECT COALESCE(SUM(amount),0) AS n FROM payments WHERE fulfilled_at IS NOT NULL').get().n });
});
app.get('/api/admin/reports', requireAuth, requireAdmin, (_req,res) => res.json({ reports:db.prepare('SELECT r.*,u.username AS reporter FROM reports r JOIN users u ON u.id=r.reporter_id ORDER BY r.id DESC LIMIT 200').all() }));
app.patch('/api/admin/reports/:id', requireAuth, requireAdmin, (req,res) => {
  const status = String(req.body?.status || '');
  if (!['open','reviewing','resolved','dismissed'].includes(status)) return apiError(res,400,'Invalid report status.');
  const result = db.prepare('UPDATE reports SET status=? WHERE id=?').run(status,Number(req.params.id));
  if (!result.changes) return apiError(res,404,'Report not found.');
  res.json({ok:true});
});
app.get('/api/admin/ads', requireAuth, requireAdmin, (_req,res) => res.json({ settings:db.prepare('SELECT enabled,network,publisher_id,updated_at FROM ad_settings WHERE id=1').get() }));
app.patch('/api/admin/ads', requireAuth, requireAdmin, (req,res) => {
  const enabled = req.body?.enabled ? 1 : 0;
  const network = String(req.body?.network || 'direct');
  const publisherId = String(req.body?.publisherId || '').trim().slice(0,200);
  if (!['direct','adsense','admanager','none'].includes(network)) return apiError(res,400,'Unsupported ad network.');
  db.prepare('UPDATE ad_settings SET enabled=?,network=?,publisher_id=?,updated_at=CURRENT_TIMESTAMP WHERE id=1').run(enabled,network,publisherId);
  res.json({settings:db.prepare('SELECT enabled,network,publisher_id,updated_at FROM ad_settings WHERE id=1').get()});
});

app.use((err, _req, res, _next) => {
  if (err instanceof multer.MulterError) return apiError(res,400,err.code === 'LIMIT_FILE_SIZE' ? 'Upload is too large.' : 'Upload could not be accepted.');
  if (err) { console.error('Request error:',err.message); return apiError(res,400,err.message || 'Invalid request.'); }
  return apiError(res,500,'Unexpected server error.');
});

function sortObject(value) {
  if (Array.isArray(value)) return value.map(sortObject);
  if (value && typeof value === 'object') return Object.keys(value).sort().reduce((out,key)=>{out[key]=sortObject(value[key]);return out;},{});
  return value;
}
function safeEqual(a,b) { const aa=Buffer.from(String(a)); const bb=Buffer.from(String(b)); return aa.length===bb.length && crypto.timingSafeEqual(aa,bb); }
app.listen(PORT, () => console.log(`CARTEENACLUB API listening on port ${PORT}`));
