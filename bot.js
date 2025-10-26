import 'dotenv/config';
import bedrock from 'bedrock-protocol';
import { request } from 'undici';

// === CONFIG ===
const {
  GEMINI_API_KEY,
  SERVER_HOST = 'localhost',
  SERVER_PORT = 55608,
  USERNAME = 'BotG',
  KEEPALIVE_URL
} = process.env;

if (!GEMINI_API_KEY) {
  console.error('❌ Missing GEMINI_API_KEY. Set it in Render dashboard.');
  process.exit(1);
}

// === KEEPALIVE LOOP ===
if (KEEPALIVE_URL) {
  setInterval(async () => {
    try {
      const res = await fetch(KEEPALIVE_URL);
      console.log(`[KeepAlive] Ping ${KEEPALIVE_URL} → ${res.status}`);
    } catch (err) {
      console.error('[KeepAlive] Failed:', err.message);
    }
  }, 1000 * 60 * 5); // every 5 min
}

// === CONNECT TO BEDROCK ===
const client = bedrock.createClient({
  host: SERVER_HOST,
  port: Number(SERVER_PORT),
  username: USERNAME,
  offline: true
});

client.on('connect', () => console.log(`✅ Connected to ${SERVER_HOST}:${SERVER_PORT}`));
client.on('disconnect', e => console.log('❌ Disconnected:', e));

// Chat messages
client.on('text', pkt => console.log(`[CHAT] ${pkt.message}`));

// Basic player position updates (depends on lib version)
client.on('move_player', pkt => {
  console.log(`📍 Pos: x=${pkt.position.x.toFixed(1)} y=${pkt.position.y.toFixed(1)} z=${pkt.position.z.toFixed(1)}`);
});

// === GEMINI QUERY ===
async function askGemini(prompt) {
  const body = {
    contents: [{ parts: [{ text: prompt }]}],
  };

  // replace with real Gemini endpoint
  const res = await request('https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-latest:generateContent', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${GEMINI_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });

  if (res.statusCode >= 400) {
    const err = await res.body.text();
    throw new Error(`Gemini error ${res.statusCode}: ${err}`);
  }

  const data = await res.body.json();
  return data?.candidates?.[0]?.content?.parts?.[0]?.text ?? 'No response';
}

// === MAIN PLANNING LOOP ===
async function planningLoop() {
  while (true) {
    try {
      const stateSummary = {
        time: new Date().toISOString(),
        server: SERVER_HOST,
        username: USERNAME
      };

      const prompt = `State: ${JSON.stringify(stateSummary)}.
      Plan the next Minecraft Bedrock survival step to beat the game efficiently. 
      Return one actionable instruction (e.g., "mine iron", "craft pickaxe", "go to nether").`;

      const plan = await askGemini(prompt);
      console.log('🧭 Gemini Suggestion →', plan);
    } catch (err) {
      console.error('Planning error:', err.message);
    }
    await new Promise(r => setTimeout(r, 8000)); // wait 8 s
  }
}

planningLoop().catch(console.error);
