import 'dotenv/config';
import bedrock from 'bedrock-protocol';
import { request } from 'undici';
import express from 'express';
import { EventEmitter } from 'events';

// === CONFIGURATION ===
const config = {
  gemini: {
    apiKey: process.env.GEMINI_API_KEY,
    model: 'gemini-2.0-flash-exp',
    endpoint: 'https://generativelanguage.googleapis.com/v1beta'
  },
  server: {
    host: process.env.SERVER_HOST || 'localhost',
    port: parseInt(process.env.SERVER_PORT || '19132'),
    username: process.env.USERNAME || 'BotG'
  },
  web: {
    port: parseInt(process.env.PORT || '10000')
  },
  bot: {
    thinkInterval: 8000,
    actionTimeout: 30000,
    maxConsecutiveErrors: 5
  }
};

if (!config.gemini.apiKey) {
  console.error('❌ Missing GEMINI_API_KEY in environment variables');
  process.exit(1);
}

// === ENHANCED STATE MANAGER ===
class BotState extends EventEmitter {
  constructor() {
    super();
    this.position = { x: 0, y: 0, z: 0 };
    this.rotation = { yaw: 0, pitch: 0 };
    this.health = 20;
    this.hunger = 20;
    this.inventory = [];
    this.nearbyBlocks = [];
    this.nearbyEntities = [];
    this.currentGoal = 'survive';
    this.achievements = [];
    this.gamePhase = 'early';
    this.actionHistory = [];
    this.lastUpdate = Date.now();
    this.isDay = true;
    this.consecutiveErrors = 0;
    this.entityId = 0n;
  }

  update(data) {
    Object.assign(this, data);
    this.lastUpdate = Date.now();
    this.emit('stateChanged', this);
  }

  addToHistory(action, result, details = '') {
    this.actionHistory.push({
      timestamp: new Date().toISOString(),
      action,
      result,
      details,
      phase: this.gamePhase,
      position: { ...this.position }
    });
    
    if (this.actionHistory.length > 100) {
      this.actionHistory = this.actionHistory.slice(-100);
    }
  }

  getContextForAI() {
    const recent = this.actionHistory.slice(-5);
    return {
      current: {
        position: `(${this.position.x.toFixed(1)}, ${this.position.y.toFixed(1)}, ${this.position.z.toFixed(1)})`,
        health: `${this.health}/20`,
        hunger: `${this.hunger}/20`,
        inventoryCount: this.inventory.length,
        gamePhase: this.gamePhase,
        currentGoal: this.currentGoal,
        timeOfDay: this.isDay ? 'Day' : 'Night'
      },
      recentActions: recent.map(a => `${a.action} → ${a.result} ${a.details}`),
      hasItems: this.inventory.length > 0,
      canSurvive: this.health > 5 && this.hunger > 5
    };
  }

  determineGamePhase() {
    const items = this.inventory.map(i => i.name?.toLowerCase() || '');
    
    if (items.some(i => i.includes('diamond') || i.includes('netherite'))) {
      return 'late';
    }
    if (items.some(i => i.includes('iron'))) {
      return 'mid';
    }
    return 'early';
  }
}

// === GEMINI AI CONTROLLER ===
class GeminiController {
  constructor(apiKey) {
    this.apiKey = apiKey;
    this.conversationHistory = [];
    this.systemPrompt = this.buildSystemPrompt();
  }

  buildSystemPrompt() {
    return `You are an AI controlling a Minecraft Bedrock Edition bot. Your ultimate goal: SURVIVE and PROGRESS toward beating the game (killing the Ender Dragon).

AVAILABLE ACTIONS (respond with exact command):
• move <direction> <blocks> - Move north/south/east/west (e.g., "move north 10")
• mine <target> - Mine blocks (e.g., "mine wood", "mine stone", "mine down")
• explore - Wander randomly to discover resources
• jumpmove <direction> <blocks> - Jump while moving (useful for obstacles)
• attack - Attack nearby hostile mobs
• chat <message> - Send chat message
• wait - Do nothing this turn (observe)

SURVIVAL STRATEGY:
PHASE 1 (EARLY - First 5 minutes):
1. Punch trees → get wood (move to trees, mine wood)
2. Craft wooden pickaxe (chat /give @s wooden_pickaxe)
3. Mine stone → upgrade to stone tools
4. Find coal for torches
5. Build simple shelter before night

PHASE 2 (MID - After basic tools):
1. Mine iron ore in caves
2. Smelt iron → craft iron tools/armor
3. Establish food source
4. Explore for diamonds (below Y=16)

PHASE 3 (LATE - Diamond gear):
1. Get obsidian for Nether portal
2. Enter Nether for blaze rods
3. Find stronghold with ender pearls
4. Prepare for End battle

CRITICAL RULES:
• ALWAYS consider health/hunger - eat if low
• Avoid danger if health < 10
• Don't mine at night without shelter
• Must have tools before mining stone/iron
• Be SPECIFIC: "move north 5" not just "move"
• Take ONE action per response

RESPONSE FORMAT:
Think step-by-step, then provide ONE specific action:
<thinking>
Current situation: [analyze state]
Next logical step: [reasoning]
</thinking>

ACTION: <your exact command here>`;
  }

  async think(state) {
    const context = state.getContextForAI();
    const prompt = this.buildPrompt(context);
    
    try {
      const response = await this.callGemini(prompt);
      const action = this.parseAction(response);
      
      this.conversationHistory.push({
        context,
        response,
        action,
        timestamp: new Date().toISOString()
      });

      if (this.conversationHistory.length > 20) {
        this.conversationHistory = this.conversationHistory.slice(-20);
      }

      return action;
    } catch (error) {
      console.error('🚨 Gemini Error:', error.message);
      state.consecutiveErrors++;
      
      if (state.consecutiveErrors > config.bot.maxConsecutiveErrors) {
        console.log('⚠️  Too many errors, using safe fallback');
        return this.safeFallback(state);
      }
      
      return { action: 'wait', reasoning: 'Error recovery' };
    }
  }

  buildPrompt(context) {
    const recentHistory = context.recentActions.length > 0 
      ? context.recentActions.join('\n') 
      : 'No actions yet';

    return `${this.systemPrompt}

CURRENT STATE:
Position: ${context.current.position}
Health: ${context.current.health} | Hunger: ${context.current.hunger}
Phase: ${context.current.gamePhase}
Goal: ${context.current.currentGoal}
Time: ${context.current.timeOfDay}
Inventory: ${context.current.inventoryCount} items

RECENT ACTIONS:
${recentHistory}

What should I do next? Respond with your thinking and ONE specific action command.`;
  }

  async callGemini(prompt) {
    const body = {
      contents: [{
        parts: [{ text: prompt }]
      }],
      generationConfig: {
        temperature: 0.8,
        maxOutputTokens: 300,
        topP: 0.95
      }
    };

    const url = `${config.gemini.endpoint}/models/${config.gemini.model}:generateContent?key=${this.apiKey}`;
    
    const res = await request(url, {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    });

    if (res.statusCode >= 400) {
      const error = await res.body.text();
      throw new Error(`HTTP ${res.statusCode}: ${error}`);
    }

    const data = await res.body.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    
    if (!text) {
      throw new Error('Empty response from Gemini');
    }

    return text;
  }

  parseAction(response) {
    console.log('🧠 Gemini Response:\n', response, '\n');

    const actionMatch = response.match(/ACTION:\s*(.+?)(?:\n|$)/i);
    if (actionMatch) {
      const actionStr = actionMatch[1].trim();
      return {
        action: actionStr,
        reasoning: response.split('ACTION:')[0].trim()
      };
    }

    const commands = ['move', 'mine', 'explore', 'attack', 'chat', 'wait', 'jumpmove'];
    for (const cmd of commands) {
      const regex = new RegExp(`${cmd}\\s+[^\\n]+`, 'i');
      const match = response.match(regex);
      if (match) {
        return {
          action: match[0].trim(),
          reasoning: 'Extracted from response'
        };
      }
    }

    return {
      action: 'explore',
      reasoning: 'Could not parse action, defaulting to explore'
    };
  }

  safeFallback(state) {
    if (state.health < 10) {
      return { action: 'wait', reasoning: 'Low health, being cautious' };
    }
    if (state.gamePhase === 'early') {
      return { action: 'mine wood', reasoning: 'Need basic resources' };
    }
    return { action: 'explore', reasoning: 'Safe exploration' };
  }
}

// === ACTION EXECUTOR ===
class ActionExecutor {
  constructor(client, state) {
    this.client = client;
    this.state = state;
    this.isBusy = false;
  }

  async execute(plan) {
    if (this.isBusy) {
      console.log('⏳ Still executing previous action...');
      return { success: false, message: 'Busy' };
    }

    this.isBusy = true;
    console.log(`\n🎯 Executing: ${plan.action}`);

    try {
      const result = await this.performAction(plan.action);
      this.state.consecutiveErrors = 0;
      this.state.addToHistory(plan.action, result.success ? '✓' : '✗', result.message);
      
      console.log(result.success ? '✅' : '❌', result.message);
      return result;
    } catch (error) {
      console.error('⚠️  Execution error:', error.message);
      this.state.addToHistory(plan.action, 'ERROR', error.message);
      return { success: false, message: error.message };
    } finally {
      this.isBusy = false;
    }
  }

  async performAction(actionString) {
    const parts = actionString.toLowerCase().trim().split(/\s+/);
    const command = parts[0];
    const args = parts.slice(1);

    const actions = {
      move: () => this.move(args[0], parseInt(args[1]) || 5),
      jumpmove: () => this.jumpMove(args[0], parseInt(args[1]) || 5),
      mine: () => this.mine(args.join(' ')),
      explore: () => this.explore(),
      attack: () => this.attack(),
      chat: () => this.chat(args.join(' ')),
      wait: () => this.wait()
    };

    const actionFn = actions[command];
    if (!actionFn) {
      return { success: false, message: `Unknown command: ${command}` };
    }

    return await Promise.race([
      actionFn(),
      this.timeout(config.bot.actionTimeout)
    ]);
  }

  async move(direction, blocks) {
    const directions = {
      north: { x: 0, z: -1, yaw: 180 },
      south: { x: 0, z: 1, yaw: 0 },
      east: { x: 1, z: 0, yaw: 270 },
      west: { x: -1, z: 0, yaw: 90 }
    };

    const dir = directions[direction];
    if (!dir) {
      return { success: false, message: `Invalid direction: ${direction}` };
    }

    const steps = Math.min(blocks * 4, 40);
    const stepSize = blocks / steps;

    for (let i = 0; i < steps; i++) {
      const newPos = {
        x: this.state.position.x + (dir.x * stepSize),
        y: this.state.position.y,
        z: this.state.position.z + (dir.z * stepSize)
      };

      this.client.write('move_player', {
        runtime_id: this.state.entityId,
        position: newPos,
        rotation: { yaw: dir.yaw, pitch: 0, head_yaw: dir.yaw },
        mode: 0,
        on_ground: true,
        ridden_runtime_id: 0n,
        tick: 0n
      });

      this.state.position = newPos;
      this.state.rotation = { yaw: dir.yaw, pitch: 0 };

      await this.sleep(50);
    }

    return { success: true, message: `Moved ${direction} ${blocks} blocks` };
  }

  async jumpMove(direction, blocks) {
    const directions = {
      north: { x: 0, z: -1, yaw: 180 },
      south: { x: 0, z: 1, yaw: 0 },
      east: { x: 1, z: 0, yaw: 270 },
      west: { x: -1, z: 0, yaw: 90 }
    };

    const dir = directions[direction];
    if (!dir) {
      return { success: false, message: `Invalid direction: ${direction}` };
    }

    for (let i = 0; i < blocks; i++) {
      const jumpPos = {
        x: this.state.position.x + (dir.x * 0.5),
        y: this.state.position.y + 1.0,
        z: this.state.position.z + (dir.z * 0.5)
      };

      this.client.write('move_player', {
        runtime_id: this.state.entityId,
        position: jumpPos,
        rotation: { yaw: dir.yaw, pitch: 0, head_yaw: dir.yaw },
        mode: 0,
        on_ground: false,
        ridden_runtime_id: 0n,
        tick: 0n
      });

      this.state.position = jumpPos;
      await this.sleep(150);

      const landPos = {
        x: this.state.position.x + (dir.x * 0.5),
        y: this.state.position.y - 1.0,
        z: this.state.position.z + (dir.z * 0.5)
      };

      this.client.write('move_player', {
        runtime_id: this.state.entityId,
        position: landPos,
        rotation: { yaw: dir.yaw, pitch: 0, head_yaw: dir.yaw },
        mode: 0,
        on_ground: true,
        ridden_runtime_id: 0n,
        tick: 0n
      });

      this.state.position = landPos;
      await this.sleep(150);
    }

    return { success: true, message: `Jump-moved ${direction} ${blocks} blocks` };
  }

  async mine(target) {
    const lookDown = target.includes('down') || target.includes('stone') || target.includes('dirt');
    const pitch = lookDown ? 90 : 0;

    this.state.rotation.pitch = pitch;
    this.client.write('move_player', {
      runtime_id: this.state.entityId,
      position: this.state.position,
      rotation: { yaw: this.state.rotation.yaw, pitch, head_yaw: this.state.rotation.yaw },
      mode: 0,
      on_ground: true,
      ridden_runtime_id: 0n,
      tick: 0n
    });

    await this.sleep(300);

    const blockPos = lookDown ? {
      x: Math.floor(this.state.position.x),
      y: Math.floor(this.state.position.y) - 1,
      z: Math.floor(this.state.position.z)
    } : {
      x: Math.floor(this.state.position.x),
      y: Math.floor(this.state.position.y),
      z: Math.floor(this.state.position.z) + (this.state.rotation.yaw === 0 ? 1 : -1)
    };

    this.client.write('player_action', {
      runtime_entity_id: this.state.entityId,
      action: 0,
      position: blockPos,
      face: 1
    });

    await this.sleep(500);

    for (let i = 0; i < 5; i++) {
      this.client.write('animate', {
        action_id: 1,
        runtime_entity_id: this.state.entityId
      });
      
      await this.sleep(400);
    }

    return { success: true, message: `Mining ${target}` };
  }

  async explore() {
    const directions = ['north', 'south', 'east', 'west'];
    const randomDir = directions[Math.floor(Math.random() * directions.length)];
    const distance = 3 + Math.floor(Math.random() * 7);
    
    return await this.move(randomDir, distance);
  }

  async attack() {
    this.client.write('animate', {
      action_id: 1,
      runtime_entity_id: this.state.entityId
    });

    await this.sleep(500);
    return { success: true, message: 'Attacking nearby target' };
  }

  async chat(message) {
    this.client.write('text', {
      type: 'chat',
      needs_translation: false,
      source_name: config.server.username,
      message: message || 'Hello!',
      xuid: '',
      platform_chat_id: ''
    });

    await this.sleep(500);
    return { success: true, message: `Sent: ${message}` };
  }

  async wait() {
    await this.sleep(2000);
    return { success: true, message: 'Waiting and observing' };
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  timeout(ms) {
    return new Promise((_, reject) => 
      setTimeout(() => reject(new Error('Action timeout')), ms)
    );
  }
}

// === MINECRAFT BOT ===
class MinecraftBot extends EventEmitter {
  constructor() {
    super();
    this.client = null;
    this.state = new BotState();
    this.ai = new GeminiController(config.gemini.apiKey);
    this.executor = null;
    this.isRunning = false;
    this.thinkCount = 0;
    this.positionSyncInterval = null;
  }

  async connect() {
    console.log(`🔗 Connecting to ${config.server.host}:${config.server.port}...`);
    
    this.client = bedrock.createClient({
      host: config.server.host,
      port: config.server.port,
      username: config.server.username,
      offline: true
    });

    this.executor = new ActionExecutor(this.client, this.state);
    this.setupEventHandlers();

    return new Promise((resolve) => {
      this.client.once('spawn', () => {
        console.log('✅ Bot spawned and ready!\n');
        this.isRunning = true;
        this.startPositionSync();
        resolve();
      });
    });
  }

  setupEventHandlers() {
    this.client.on('disconnect', (reason) => {
      console.log('❌ Disconnected:', reason);
      this.isRunning = false;
      if (this.positionSyncInterval) {
        clearInterval(this.positionSyncInterval);
      }
    });

    this.client.on('error', (error) => {
      console.error('🚨 Client error:', error.message);
    });

    this.client.on('text', (pkt) => {
      console.log(`💬 [CHAT] ${pkt.message}`);
    });

    this.client.on('start_game', (pkt) => {
      if (pkt.runtime_entity_id) {
        this.state.entityId = pkt.runtime_entity_id;
        console.log('🆔 Entity ID:', this.state.entityId);
      }
      
      if (pkt.player_position) {
        console.log('📍 Spawn position:', pkt.player_position);
        this.state.update({
          position: pkt.player_position,
          rotation: { yaw: 0, pitch: 0 }
        });
      }
    });

    this.client.on('move_player', (pkt) => {
      if (pkt.position && pkt.runtime_id === this.state.entityId) {
        this.state.update({
          position: pkt.position,
          rotation: pkt.rotation || this.state.rotation
        });
      }
    });

    this.client.on('set_health', (pkt) => {
      if (pkt.health !== undefined) {
        this.state.update({ health: pkt.health });
        console.log(`💚 Health: ${pkt.health}/20`);
      }
    });

    this.client.on('inventory_content', (pkt) => {
      this.state.update({ 
        inventory: pkt.items || [],
        gamePhase: this.state.determineGamePhase()
      });
    });

    this.client.on('update_attributes', (pkt) => {
      if (pkt.runtime_entity_id === this.state.entityId && pkt.attributes) {
        const healthAttr = pkt.attributes.find(a => a.name === 'minecraft:health');
        if (healthAttr) {
          this.state.update({ health: healthAttr.current });
        }
      }
    });
  }

  startPositionSync() {
    this.positionSyncInterval = setInterval(() => {
      if (this.isRunning && this.state.position && this.state.entityId) {
        this.client.write('move_player', {
          runtime_id: this.state.entityId,
          position: this.state.position,
          rotation: this.state.rotation,
          mode: 0,
          on_ground: true,
          ridden_runtime_id: 0n,
          tick: 0n
        });
      }
    }, 100);
  }

  async aiLoop() {
    console.log('🤖 Starting Gemini AI control loop...\n');
    console.log('='.repeat(60));

    while (this.isRunning) {
      try {
        this.thinkCount++;
        console.log(`\n${'='.repeat(60)}`);
        console.log(`🧠 AI Think Cycle #${this.thinkCount}`);
        console.log('='.repeat(60));

        const decision = await this.ai.think(this.state);
        await this.executor.execute(decision);
        await this.sleep(config.bot.thinkInterval);
        
      } catch (error) {
        console.error('💥 Loop error:', error.message);
        await this.sleep(5000);
      }
    }
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async shutdown() {
    console.log('\n🛑 Shutting down bot...');
    this.isRunning = false;
    if (this.positionSyncInterval) {
      clearInterval(this.positionSyncInterval);
    }
    if (this.client) {
      this.client.close();
    }
  }
}

// === WEB DASHBOARD ===
const app = express();
app.use(express.json());

let bot = null;

app.get('/', (req, res) => {
  if (!bot) {
    return res.json({ status: 'initializing' });
  }

  const context = bot.state.getContextForAI();
  res.json({
    status: 'online',
    bot: context.current,
    recentActions: context.recentActions,
    thinkCycles: bot.thinkCount,
    entityId: bot.state.entityId.toString()
  });
});

app.get('/history', (req, res) => {
  res.json({
    actions: bot ? bot.state.actionHistory.slice(-30) : [],
    total: bot ? bot.state.actionHistory.length : 0
  });
});

app.post('/command', async (req, res) => {
  if (!bot || !bot.executor) {
    return res.status(503).json({ error: 'Bot not ready' });
  }

  const { action } = req.body;
  if (!action) {
    return res.status(400).json({ error: 'Missing action' });
  }

  try {
    const result = await bot.executor.execute({ action, reasoning: 'Manual command' });
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// === MAIN ===
async function main() {
  console.log('🚀 Gemini-Controlled Minecraft Bot v3.0\n');

  app.listen(config.web.port, () => {
    console.log(`🌐 Dashboard: http://localhost:${config.web.port}`);
    console.log(`📊 Endpoints: GET /, GET /history, POST /command\n`);
  });

  bot = new MinecraftBot();
  await bot.connect();

  process.on('SIGINT', async () => {
    console.log('\n👋 Received shutdown signal');
    await bot.shutdown();
    process.exit(0);
  });

  await bot.aiLoop();
}

main().catch(error => {
  console.error('💥 Fatal error:', error);
  process.exit(1);
});
