import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import tmi from 'tmi.js';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const {
  TWITCH_BOT_USERNAME,
  TWITCH_OAUTH_TOKEN,
  TWITCH_CHANNEL,
  PORT = 3000,
} = process.env;

if (!TWITCH_BOT_USERNAME || !TWITCH_OAUTH_TOKEN || !TWITCH_CHANNEL) {
  console.error('Faltan variables en .env');
  process.exit(1);
}

// ===== DB =====
const db = await open({
  filename: 'db.sqlite',
  driver: sqlite3.Database
});
await db.exec(`
CREATE TABLE IF NOT EXISTS videos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  url TEXT NOT NULL,
  platform TEXT,
  user TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
`);

// Rate limit en memoria
const lastUse = new Map();
const RATE_SECONDS = 60;

function isValidUrl(str) {
  try { new URL(str); return true; } catch { return false; }
}

function detectPlatform(url) {
  const u = url.toLowerCase();
  if (u.includes('youtube.com') || u.includes('youtu.be')) return 'youtube';
  if (u.includes('twitch.tv')) return 'twitch';
  if (u.includes('tiktok.com')) return 'tiktok';
  if (u.includes('twitter.com') || u.includes('x.com')) return 'twitter';
  return 'other';
}

function getEmbedLink(url, platform) {
  if (platform === 'youtube') {
    let videoId = null;

    // Caso 1: links largos con watch?v=
    if (url.includes('watch?v=')) {
      const params = new URL(url).searchParams;
      videoId = params.get('v');
    }

    // Caso 2: links cortos youtu.be
    if (!videoId && url.includes('youtu.be/')) {
      videoId = url.split('youtu.be/')[1].split('?')[0];
    }

    // Generar embed
    if (videoId) {
      return `https://www.youtube.com/embed/${videoId}`;
    }
  }

  if (platform === 'twitch') {
    // Clips de Twitch requieren parent param: tu dominio o localhost
    // Ejemplo: https://clips.twitch.tv/embed?clip=ClipID&parent=localhost
    return url;
  }

  if (platform === 'tiktok') {
    return url; // TikTok requiere script oficial
  }

  return '';
}


// ===== API =====
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// API para obtener todos los videos con datos para previsualización
app.get('/api/videos', async (req, res) => {
  const rows = await db.all(`SELECT * FROM videos ORDER BY created_at ASC`);
  const enriched = rows.map(v => ({
    ...v,
    embed: getEmbedLink(v.url, v.platform)
  }));
  res.json(enriched);
});

// Borrar un video
app.delete('/api/videos/:id', async (req, res) => {
  await db.run(`DELETE FROM videos WHERE id = ?`, req.params.id);
  res.json({ ok: true });
});

// Limpiar todos los videos
app.post('/api/clear', async (req, res) => {
  await db.exec(`DELETE FROM videos; VACUUM;`);
  res.json({ ok: true });
});

// ===== BOT =====
const client = new tmi.Client({
  options: { debug: false },
  identity: {
    username: TWITCH_BOT_USERNAME,
    password: TWITCH_OAUTH_TOKEN,
  },
  channels: [TWITCH_CHANNEL]
});

client.connect().then(() => console.log('✅ Bot conectado a Twitch')).catch(console.error);

const COMMANDS = ['!video', '!v', '!addvideo'];

client.on('message', async (channel, tags, message, self) => {
  if (self) return;
  const msg = message.trim();
  const cmd = COMMANDS.find(c => msg.toLowerCase().startsWith(c + ' '));
  if (!cmd) return;

  const now = Date.now();
  const user = tags['display-name'] || tags.username;
  const last = lastUse.get(user) || 0;
  if (now - last < RATE_SECONDS * 1000) {
    const left = Math.ceil((RATE_SECONDS * 1000 - (now - last)) / 1000);
    client.say(channel, `@${user} espera ${left}s para enviar otro video 😊`);
    return;
  }

  const url = msg.slice(cmd.length).trim();
  if (!isValidUrl(url)) {
    client.say(channel, `@${user} formato inválido. Usa: ${cmd} <URL del video>`);
    return;
  }

  const dup = await db.get("SELECT id FROM videos WHERE url = ?", url);
  if (dup) {
    client.say(channel, `@${user} ese link ya está en la lista.`);
    return;
  }

  const platform = detectPlatform(url);
  await db.run(`INSERT INTO videos (url, platform, user) VALUES (?,?,?)`, url, platform, user);
  lastUse.set(user, now);

  client.say(channel, `@${user} agregado ✅ | Aparecerá en la lista en unos segundos.`);
});

app.listen(PORT, () => console.log(`🌐 Servidor en http://localhost:${PORT}`));
