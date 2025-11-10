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

app.listen(PORT, () => console.log(`✅ Server running on http://localhost:${PORT}`));
