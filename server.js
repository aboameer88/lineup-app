// server.js – Abo Ameer Lineups (MongoDB + 48h TTL)

const express = require('express');
const cors = require('cors');
const path = require('path');
const { MongoClient, ObjectId } = require('mongodb');

const app = express();
const PORT = process.env.PORT || 10000;

// ===== Express setup =====
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ===== MongoDB setup =====
const MONGO_URI = process.env.MONGODB_URI;
let client;
let Lineups;
let useMemoryFallback = false;

// تخزين مؤقت احتياطي لو صار أي مشكلة مع Mongo (ما نستخدمه إلا وقت الحاجة)
const memoryStore = new Map();

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}
function makePlayers() {
  return Array(11)
    .fill(null)
    .map((_, i) => ({ number: i + 1, name: '', claimedBy: null }));
}

async function initDb() {
  if (!MONGO_URI) {
    console.warn('⚠️ MONGODB_URI not set, using in-memory store only.');
    useMemoryFallback = true;
    return;
  }

  try {
    client = new MongoClient(MONGO_URI);
    await client.connect();
    const db = client.db('lineup');
    Lineups = db.collection('lineups');
    await Lineups.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });

    console.log('✅ MongoDB connected & TTL index ensured');
  } catch (err) {
    console.error('Mongo init error', err);
    console.warn('⚠️ Falling back to in-memory store.');
    useMemoryFallback = true;
  }
}

initDb();

// ===== Helper to store / read (Mongo أو Memory) =====
async function saveLineup(doc) {
  if (useMemoryFallback) {
    const id = Date.now().toString(36) + Math.random().toString(36).substring(2, 8);
    memoryStore.set(id, doc);
    return id;
  } else {
    const result = await Lineups.insertOne(doc);
    return String(result.insertedId);
  }
}

async function loadLineup(id) {
  if (useMemoryFallback) {
    const doc = memoryStore.get(id);
    return doc || null;
  } else {
    let _id;
    try {
      _id = new ObjectId(id);
    } catch {
      return null;
    }
    const doc = await Lineups.findOne({ _id });
    return doc || null;
  }
}

async function updatePlayers(id, players) {
  if (useMemoryFallback) {
    const doc = memoryStore.get(id);
    if (!doc) return false;
    doc.players = players;
    memoryStore.set(id, doc);
    return true;
  } else {
    let _id;
    try {
      _id = new ObjectId(id);
    } catch {
      return false;
    }
    const res = await Lineups.updateOne(
      { _id },
      { $set: { players } }
    );
    return res.matchedCount === 1;
  }
}

// ===== Routes =====

// Health check
app.get('/api/health', (req, res) => {
  res.json({ ok: true, memoryFallback: useMemoryFallback });
});

// إنشاء تشكيلة + رابط 48 ساعة
app.post('/api/lineups', async (req, res) => {
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

    const id = await saveLineup(doc);
    return res.json({ id });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ message: 'DB error' });
  }
});

// قراءة تشكيلة بالرابط
app.get('/api/lineups/:id', async (req, res) => {
  try {
    const id = req.params.id;
    const doc = await loadLineup(id);
    if (!doc) {
      return res.status(404).json({ message: 'غير موجود' });
    }
    if (doc.expiresAt && doc.expiresAt < new Date()) {
      return res.status(410).json({ message: 'انتهت صلاحية الرابط' });
    }

    return res.json({
      data: {
        teamAName: doc.teamAName,
        teamBName: doc.teamBName,
        teamAColor: doc.teamAColor,
        teamBColor: doc.teamBColor,
        players: doc.players,
        positions: doc.positions,
        playersCount: doc.playersCount
      }
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ message: 'DB error' });
  }
});

// حجز مركز (لاعب واحد لكل شخص)
app.post('/api/lineups/:id/claim', async (req, res) => {
  try {
    const { participantId, team, index, name } = req.body || {};
    if (!participantId || !team || typeof index !== 'number' || !name) {
      return res.status(400).json({ error: 'bad_request' });
    }

    const id = req.params.id;
    const doc = await loadLineup(id);
    if (!doc) return res.status(404).json({ error: 'not_found' });
    if (doc.expiresAt && doc.expiresAt < new Date()) {
      return res.status(410).json({ error: 'link_expired' });
    }

    const count = doc.playersCount || 11;
    if (index < 0 || index >= count) {
      return res.status(400).json({ error: 'out_of_range' });
    }

    const alreadyUsed = ['A', 'B'].some((t) =>
      (doc.players[t] || []).some((p) => p && p.claimedBy === participantId)
    );
    if (alreadyUsed) {
      return res.status(400).json({ error: 'already_used' });
    }

    if (doc.players[team][index]?.name?.trim()) {
      return res.status(400).json({ error: 'slot_taken' });
    }

    doc.players[team][index].name = String(name).trim();
    doc.players[team][index].claimedBy = participantId;

    await updatePlayers(id, doc.players);

    return res.json({ ok: true, players: doc.players });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'db_error' });
  }
});

// إلغاء حجز مركز اللاعب نفسه
app.post('/api/lineups/:id/unclaim', async (req, res) => {
  try {
    const { participantId, team, index } = req.body || {};
    if (!participantId || !team || typeof index !== 'number') {
      return res.status(400).json({ error: 'bad_request' });
    }

    const id = req.params.id;
    const doc = await loadLineup(id);
    if (!doc) return res.status(404).json({ error: 'not_found' });
    if (doc.expiresAt && doc.expiresAt < new Date()) {
      return res.status(410).json({ error: 'link_expired' });
    }

    const slot = doc.players[team][index];
    if (!slot || slot.claimedBy !== participantId) {
      return res.status(400).json({ error: 'not_your_slot' });
    }

    slot.name = '';
    slot.claimedBy = null;

    await updatePlayers(id, doc.players);

    return res.json({ ok: true, players: doc.players });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'db_error' });
  }
});

// ===== Start server =====
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
