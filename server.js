const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// -------------------------
// قاعدة بيانات مؤقتة في الذاكرة
// -------------------------
const lineups = {};
const HOURS_48 = 48 * 60 * 60 * 1000;

function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).substring(2, 8);
}
function isExpired(lineup) {
  return Date.now() > lineup.expiresAt;
}

// -------------------------
// إنشاء تشكيلة جديدة
// -------------------------
app.post('/api/lineups', (req, res) => {
  const { teamAName, teamBName, teamAColor, teamBColor, players, playersCount, positions } = req.body;
  if (!players || !players.A || !players.B) return res.status(400).json({ error: 'players data is required' });

  const safePlayersCount = Math.max(7, Math.min(11, playersCount || 11));
  const id = generateId();
  const createdAt = Date.now();
  const expiresAt = createdAt + HOURS_48;

  lineups[id] = {
    id,
    createdAt,
    expiresAt,
    data: { teamAName, teamBName, teamAColor, teamBColor, players, playersCount: safePlayersCount, positions: positions || null },
    participants: {}
  };

  res.json({ id, expiresAt });
});

// -------------------------
// جلب تشكيلة من الرابط
// -------------------------
app.get('/api/lineups/:id', (req, res) => {
  const lineup = lineups[req.params.id];
  if (!lineup) return res.status(404).json({ error: 'lineup not found' });
  if (isExpired(lineup)) return res.status(410).json({ error: 'link_expired', message: 'انتهت صلاحية الرابط (48 ساعة)' });
  res.json({ id: lineup.id, createdAt: lineup.createdAt, expiresAt: lineup.expiresAt, data: lineup.data });
});

// -------------------------
// حجز مركز
// -------------------------
app.post('/api/lineups/:id/claim', (req, res) => {
  const { participantId, team, index, name } = req.body;
  const lineup = lineups[req.params.id];
  if (!lineup) return res.status(404).json({ error: 'lineup not found' });
  if (isExpired(lineup)) return res.status(410).json({ error: 'link_expired', message: 'انتهت صلاحية الرابط (48 ساعة)' });

  if (!participantId || !team || typeof index !== 'number' || !name)
    return res.status(400).json({ error: 'invalid payload' });

  const players = lineup.data.players;
  if (!players[team] || !players[team][index]) return res.status(400).json({ error: 'invalid team/index' });
  if (players[team][index].name && players[team][index].name.trim() !== '')
    return res.status(409).json({ error: 'slot_taken', message: 'المركز محجوز بالفعل' });

  players[team][index].name = name.trim();
  players[team][index].claimedBy = participantId;
  lineup.participants[participantId] = { team, index, active: true };

  res.json({ success: true, players });
});

// -------------------------
// إزالة اسم لاعب من مركزه
// -------------------------
app.post('/api/lineups/:id/unclaim', (req, res) => {
  const { participantId, team, index } = req.body;
  const lineup = lineups[req.params.id];
  if (!lineup) return res.status(404).json({ error: 'lineup not found' });
  if (isExpired(lineup)) return res.status(410).json({ error: 'link_expired', message: 'انتهت صلاحية الرابط (48 ساعة)' });

  const players = lineup.data.players;
  if (!players[team] || !players[team][index]) return res.status(400).json({ error: 'invalid team/index' });

  const slot = players[team][index];
  if (slot.claimedBy !== participantId)
    return res.status(403).json({ error: 'not_owner', message: 'لا يمكنك إزالة اسم لاعب آخر' });

  slot.name = '';
  slot.claimedBy = null;
  if (lineup.participants[participantId]) lineup.participants[participantId].active = false;

  res.json({ success: true, players });
});

// -------------------------
// صفحة الواجهة الرئيسية
// -------------------------
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});
// ===== MongoDB setup =====
const { MongoClient, ObjectId } = require('mongodb');

const MONGO_URI = process.env.MONGODB_URI; // ضفّناها في Render
if (!MONGO_URI) {
  console.error('❌ Missing MONGODB_URI env var');
  process.exit(1);
}

const client = new MongoClient(MONGO_URI);
let Lineups; // collection reference

async function initDb() {
  await client.connect();
  const db = client.db('lineup');      // اسم قاعدة البيانات
  Lineups = db.collection('lineups');  // مجموعة التشكيلات

  // TTL index: حذف تلقائي عند الوصول لتاريخ expiresAt
  // (لو المؤشر موجود من قبل، ما فيه مشكلة يستعمله)
  await Lineups.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
  console.log('✅ MongoDB connected & TTL index ensured');
}
initDb().catch(err => {
  console.error('Mongo init error', err);
  process.exit(1);
});

// ===== Helpers =====
function clamp(n, min, max) { return Math.max(min, Math.min(max, n)); }
function makePlayers() {
  return Array(11).fill(null).map((_, i) => ({ number: i + 1, name: '', claimedBy: null }));
}

// ===== Routes (استبدال المنطق القديم بالذاكرة) =====

// إنشاء تشكيلة + رابط 48 ساعة
app.post('/api/lineups', express.json(), async (req, res) => {
  try {
    const payload = req.body || {};
    const now = new Date();
    const doc = {
      teamAName: payload.teamAName || 'فريق A',
      teamBName: payload.teamBName || 'فريق B',
      teamAColor: payload.teamAColor || '#2563eb',
      teamBColor: payload.teamBColor || '#dc2626',
      players: payload.players || { A: makePlayers(), B: makePlayers() },
      positions: payload.positions || { A: [], B: [] },
      playersCount: clamp(Number(payload.playersCount) || 11, 7, 11),
      createdAt: now,
      expiresAt: new Date(now.getTime() + 48 * 60 * 60 * 1000) // +48h
    };

    const result = await Lineups.insertOne(doc);
    return res.json({ id: String(result.insertedId) });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ message: 'DB error' });
  }
});

// قراءة تشكيلة بالرابط
app.get('/api/lineups/:id', async (req, res) => {
  try {
    const id = req.params.id;
    const doc = await Lineups.findOne({ _id: new ObjectId(id) });
    if (!doc) return res.status(404).json({ message: 'غير موجود' });
    if (doc.expiresAt && doc.expiresAt < new Date()) {
      return res.status(410).json({ message: 'انتهت صلاحية الرابط' });
    }
    return res.json({ data: {
      teamAName: doc.teamAName,
      teamBName: doc.teamBName,
      teamAColor: doc.teamAColor,
      teamBColor: doc.teamBColor,
      players: doc.players,
      positions: doc.positions,
      playersCount: doc.playersCount
    }});
  } catch (e) {
    console.error(e);
    return res.status(500).json({ message: 'DB error' });
  }
});

// حجز مركز (ضيف يحجز مركز واحد باسمه)
app.post('/api/lineups/:id/claim', express.json(), async (req, res) => {
  try {
    const { participantId, team, index, name } = req.body || {};
    if (!participantId || !team || typeof index !== 'number' || !name) {
      return res.status(400).json({ error: 'bad_request' });
    }

    const _id = new ObjectId(req.params.id);
    const doc = await Lineups.findOne({ _id });
    if (!doc) return res.status(404).json({ error: 'not_found' });
    if (doc.expiresAt < new Date()) return res.status(410).json({ error: 'link_expired' });

    const count = doc.playersCount || 11;
    if (index < 0 || index >= count) return res.status(400).json({ error: 'out_of_range' });

    // ممنوع يحجز أكثر من مركز
    const already = ['A','B'].some(t => (doc.players[t]||[]).some(p => p?.claimedBy === participantId));
    if (already) return res.status(400).json({ error: 'already_used' });

    // المركز محجوز؟
    if (doc.players[team][index]?.name?.trim()) {
      return res.status(400).json({ error: 'slot_taken' });
    }

    doc.players[team][index].name = String(name).trim();
    doc.players[team][index].claimedBy = participantId;

    await Lineups.updateOne({ _id }, { $set: { players: doc.players } });

    return res.json({ ok: true, players: doc.players });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'db_error' });
  }
});

// إلغاء حجز مركزه (الضيف نفسه فقط)
app.post('/api/lineups/:id/unclaim', express.json(), async (req, res) => {
  try {
    const { participantId, team, index } = req.body || {};
    if (!participantId || !team || typeof index !== 'number') {
      return res.status(400).json({ error: 'bad_request' });
    }

    const _id = new ObjectId(req.params.id);
    const doc = await Lineups.findOne({ _id });
    if (!doc) return res.status(404).json({ error: 'not_found' });
    if (doc.expiresAt < new Date()) return res.status(410).json({ error: 'link_expired' });

    const slot = doc.players[team][index];
    if (!slot || slot.claimedBy !== participantId) {
      return res.status(400).json({ error: 'not_your_slot' });
    }

    slot.name = '';
    slot.claimedBy = null;

    await Lineups.updateOne({ _id }, { $set: { players: doc.players } });

    return res.json({ ok: true, players: doc.players });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'db_error' });
  }
});

app.listen(PORT, () => console.log(`✅ Server running on http://localhost:${PORT}`));
