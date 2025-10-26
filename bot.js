import 'dotenv/config';
import bedrock from 'bedrock-protocol';
import { request } from 'undici';
import express from 'express';
import { EventEmitter } from 'events';

// === CONFIGURATION ===
const config = {
  gemini: {
    apiKey: process.env.GEMINI_API_KEY,
    model: 'gemini-1.5-flash-latest',
    endpoint: 'https://generativelanguage.googleapis.com/v1beta/models'
  },
  server: {
    host: process.env.SERVER_HOST || 'localhost',
    port: parseInt(process.env.SERVER_PORT || '19132'),
    username: process.env.USERNAME || 'GuilhermeAI'
  },
  web: {
    port: parseInt(process.env.PORT || '10000')
  },
  bot: {
    planInterval: 15000, // Plan every 15 seconds
    actionTimeout: 30000, // Max time for action execution
    maxRetries: 3
  }
};

// Validate configuration
if (!config.gemini.apiKey) {
  console.error('❌ Missing GEMINI_API_KEY in environment variables');
  process.exit(1);
}

// === STATE MANAGER ===
class BotState extends EventEmitter {
  constructor() {
    super();
    this.position = { x: 0, y: 0, z: 0 };
    this.rotation = { yaw: 0, pitch: 0 };
    this.health = 20;
    this.hunger = 20;
    this.inventory = [];
    this.nearbyEntities = [];
    this.nearbyBlocks = new Map();
    this.currentGoal = null;
    this.achievements = [];
    this.gamePhase = 'early'; // early, mid, late, endgame
    this.actionHistory = [];
    this.lastUpdate = Date.now();
  }

  update(data) {
    Object.assign(this, data);
    this.lastUpdate = Date.now();
    this.emit('stateChanged', this);
  }

  addToHistory(action, result) {
    this.actionHistory.push({
      timestamp: Date.now(),
      action,
      result,
      phase: this.gamePhase
    });
    
    // Keep only last 50 actions
    if (this.actionHistory.length > 50) {
      this.actionHistory = this.actionHistory.slice(-50);
    }
  }

  getSummary() {
    return {
      position: this.position,
      health: this.health,
      hunger: this.hunger,
      inventoryCount: this.inventory.length,
      currentGoal: this.currentGoal,
      gamePhase: this.gamePhase,
      recentActions: this.actionHistory.slice(-5),
      achievements: this.achievements
    };
  }

  determineGamePhase() {
    const items = this.inventory.map(i => i.name?.toLowerCase() || '');
    
    if (items.some(i => i.includes('elytra') || i.includes('dragon'))) {
      return 'endgame';
    }
    if (items.some(i => i.includes('diamond') || i.includes('netherite'))) {
      return 'late';
    }
    if (items.some(i => i.includes('iron'))) {
      return 'mid';
    }
    return 'early';
  }
}

// === AI PLANNER ===
class GeminiPlanner {
  constructor(apiKey) {
    this.apiKey = apiKey;
    this.conversationHistory = [];
  }

  async plan(state, context = {}) {
    const prompt = this.buildPrompt(state, context);
    
    try {
      const response = await this.callGemini(prompt);
      const plan = this.parsePlan(response);
      
      this.conversationHistory.push({
        prompt: prompt.substring(0, 200),
        response,
        timestamp: Date.now()
      });

      return plan;
    } catch (error) {
      console.error('🚨 Gemini API Error:', error.message);
      return this.fallbackPlan(state);
    }
  }

  buildPrompt(state, context) {
    const summary = state.getSummary();
    const recentHistory = state.actionHistory.slice(-3).map(a => 
      `${a.action}: ${a.result}`
    ).join('; ');

    return `You are an AI controlling a Minecraft Bedrock bot. Your goal: beat the game (kill Ender Dragon).

CURRENT STATE:
- Position: (${summary.position.x.toFixed(0)}, ${summary.position.y.toFixed(0)}, ${summary.position.z.toFixed(0)})
- Health: ${summary.health}/20, Hunger: ${summary.hunger}/20
- Inventory: ${summary.inventoryCount} items
- Game Phase: ${summary.gamePhase}
- Current Goal: ${summary.currentGoal || 'None'}
- Recent Actions: ${recentHistory || 'None'}

AVAILABLE ACTIONS:
1. mine <block> - Mine nearby blocks (wood, stone, iron, diamond, etc.)
2. craft <item> - Craft items (pickaxe, sword, armor, etc.)
3. move <direction> <distance> - Move north/south/east/west
4. explore - Search for resources or structures
5. combat <target> - Attack hostile mobs
6. build <structure> - Place blocks (shelter, portal, etc.)
7. eat <food> - Consume food to restore hunger
8. sleep - Use bed if night time

SURVIVAL PROGRESSION:
Early: Gather wood → craft tools → mine stone → find coal → build shelter
Mid: Mine iron → upgrade tools → explore caves → find diamonds → craft armor
Late: Mine diamonds → craft diamond gear → locate stronghold → prepare for Nether
Endgame: Gather blaze rods → craft ender eyes → find End Portal → defeat Dragon

Respond with JSON:
{
  "action": "exact action command",
  "reasoning": "why this action",
  "priority": "high/medium/low",
  "estimatedTime": seconds
}

Choose ONE specific action that progresses toward beating the game:`;
  }

  async callGemini(prompt) {
    const body = {
      contents: [{ 
        parts: [{ text: prompt }]
      }],
      generationConfig: {
        temperature: 0.7,
        maxOutputTokens: 500
      }
    };

    const url = `${config.gemini.endpoint}/${config.gemini.model}:generateContent?key=${this.apiKey}`;
    
    const res = await request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
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

  parsePlan(response) {
    try {
      // Try to extract JSON from response
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        return JSON.parse(jsonMatch[0]);
      }
      
      // Fallback: parse text response
      return {
        action: response.split('\n')[0].trim(),
        reasoning: 'Parsed from text response',
        priority: 'medium',
        estimatedTime: 30
      };
    } catch (error) {
      console.warn('⚠️  Failed to parse plan, using fallback');
      return {
        action: 'explore',
        reasoning: 'Default exploration action',
        priority: 'low',
        estimatedTime: 20
      };
    }
  }

  fallbackPlan(state) {
    const phase = state.gamePhase;
    const fallbacks = {
      early: { action: 'mine wood', reasoning: 'Basic resource gathering' },
      mid: { action: 'mine iron', reasoning: 'Tool upgrades needed' },
      late: { action: 'explore', reasoning: 'Search for stronghold' },
      endgame: { action: 'explore', reasoning: 'Locate End Portal' }
    };

    return {
      ...fallbacks[phase],
      priority: 'medium',
      estimatedTime: 30
    };
  }
}

// === ACTION EXECUTOR ===
class ActionExecutor {
  constructor(client, state) {
    this.client = client;
    this.state = state;
    this.currentAction = null;
    this.actionQueue = [];
  }

  async execute(plan) {
    this.currentAction = plan;
    console.log(`🎯 Executing: ${plan.action} (${plan.priority} priority)`);
    console.log(`💭 Reasoning: ${plan.reasoning}`);

    try {
      const result = await this.performAction(plan.action, plan.estimatedTime);
      this.state.addToHistory(plan.action, result.success ? 'success' : 'failed');
      
      console.log(result.success ? '✅' : '❌', result.message);
      return result;
    } catch (error) {
      console.error('⚠️  Action failed:', error.message);
      this.state.addToHistory(plan.action, 'error');
      return { success: false, message: error.message };
    } finally {
      this.currentAction = null;
    }
  }

  async performAction(actionString, timeout) {
    const [command, ...args] = actionString.toLowerCase().split(' ');

    const actions = {
      mine: () => this.mineBlock(args[0]),
      craft: () => this.craftItem(args.join(' ')),
      move: () => this.move(args[0], parseInt(args[1]) || 10),
      explore: () => this.explore(),
      combat: () => this.combat(args[0]),
      build: () => this.build(args.join(' ')),
      eat: () => this.eat(),
      sleep: () => this.sleep()
    };

    const actionFn = actions[command];
    if (!actionFn) {
      return { success: false, message: `Unknown action: ${command}` };
    }

    return await Promise.race([
      actionFn(),
      this.timeout(timeout)
    ]);
  }

  async mineBlock(blockType) {
    // Send break block packet
    this.client.queue('player_action', {
      action: 'start_break',
      position: { 
        x: Math.floor(this.state.position.x),
        y: Math.floor(this.state.position.y) - 1,
        z: Math.floor(this.state.position.z)
      }
    });

    await this.wait(2000);
    return { success: true, message: `Mining ${blockType || 'block'}` };
  }

  async craftItem(item) {
    // Send craft request packet
    this.client.queue('crafting_event', {
      type: 'craft',
      recipe: item
    });

    return { success: true, message: `Crafting ${item}` };
  }

  async move(direction, distance) {
    const directions = {
      north: { x: 0, z: -distance },
      south: { x: 0, z: distance },
      east: { x: distance, z: 0 },
      west: { x: -distance, z: 0 }
    };

    const delta = directions[direction];
    if (!delta) {
      return { success: false, message: 'Invalid direction' };
    }

    const target = {
      x: this.state.position.x + delta.x,
      y: this.state.position.y,
      z: this.state.position.z + delta.z
    };

    this.client.queue('move_player', {
      position: target,
      rotation: this.state.rotation,
      mode: 'normal'
    });

    return { success: true, message: `Moving ${direction} (${distance}m)` };
  }

  async explore() {
    // Random exploration movement
    const angle = Math.random() * Math.PI * 2;
    const distance = 10 + Math.random() * 20;
    
    const target = {
      x: this.state.position.x + Math.cos(angle) * distance,
      y: this.state.position.y,
      z: this.state.position.z + Math.sin(angle) * distance
    };

    this.client.queue('move_player', {
      position: target,
      rotation: this.state.rotation,
      mode: 'normal'
    });

    return { success: true, message: 'Exploring area' };
  }

  async combat(target) {
    this.client.queue('attack', {
      target: target || 'nearest_hostile'
    });

    return { success: true, message: `Attacking ${target}` };
  }

  async build(structure) {
    return { success: true, message: `Building ${structure}` };
  }

  async eat() {
    this.client.queue('use_item', {
      action: 'consume'
    });

    return { success: true, message: 'Eating food' };
  }

  async sleep() {
    this.client.queue('use_item', {
      action: 'sleep'
    });

    return { success: true, message: 'Sleeping' };
  }

  wait(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  timeout(ms) {
    return new Promise((_, reject) => 
      setTimeout(() => reject(new Error('Action timeout')), ms)
    );
  }
}

// === MINECRAFT CLIENT ===
class MinecraftBot extends EventEmitter {
  constructor() {
    super();
    this.client = null;
    this.state = new BotState();
    this.planner = new GeminiPlanner(config.gemini.apiKey);
    this.executor = null;
    this.isRunning = false;
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
      this.client.once('connect', () => {
        console.log('✅ Connected successfully!');
        this.isRunning = true;
        resolve();
      });
    });
  }

  setupEventHandlers() {
    this.client.on('disconnect', (reason) => {
      console.log('❌ Disconnected:', reason);
      this.isRunning = false;
    });

    this.client.on('error', (error) => {
      console.error('🚨 Client error:', error.message);
    });

    this.client.on('text', (pkt) => {
      console.log(`💬 [CHAT] ${pkt.message}`);
    });

    this.client.on('move_player', (pkt) => {
      this.state.update({
        position: pkt.position,
        rotation: pkt.rotation
      });
    });

    this.client.on('set_health', (pkt) => {
      this.state.update({ health: pkt.health });
    });

    this.client.on('inventory_content', (pkt) => {
      this.state.update({ 
        inventory: pkt.items || [],
        gamePhase: this.state.determineGamePhase()
      });
    });
  }

  async mainLoop() {
    console.log('🤖 Starting main AI loop...\n');

    while (this.isRunning) {
      try {
        // Generate plan using Gemini
        const plan = await this.planner.plan(this.state);
        
        // Execute the planned action
        await this.executor.execute(plan);
        
        // Wait before next planning cycle
        await this.sleep(config.bot.planInterval);
        
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
    console.log('🛑 Shutting down bot...');
    this.isRunning = false;
    if (this.client) {
      this.client.close();
    }
  }
}

// === WEB DASHBOARD ===
class WebDashboard {
  constructor(bot) {
    this.bot = bot;
    this.app = express();
    this.stats = {
      startTime: Date.now(),
      actionsExecuted: 0,
      errors: 0
    };

    this.setupRoutes();
  }

  setupRoutes() {
    this.app.use(express.json());

    this.app.get('/', (req, res) => {
      const uptime = Math.floor((Date.now() - this.stats.startTime) / 1000);
      res.json({
        status: 'online',
        uptime: `${uptime}s`,
        bot: {
          connected: this.bot.isRunning,
          phase: this.bot.state.gamePhase,
          position: this.bot.state.position,
          health: this.bot.state.health,
          currentGoal: this.bot.state.currentGoal
        },
        stats: this.stats
      });
    });

    this.app.get('/state', (req, res) => {
      res.json(this.bot.state.getSummary());
    });

    this.app.get('/history', (req, res) => {
      res.json({
        actions: this.bot.state.actionHistory.slice(-20),
        total: this.bot.state.actionHistory.length
      });
    });

    this.app.post('/command', async (req, res) => {
      const { action } = req.body;
      if (!action) {
        return res.status(400).json({ error: 'Missing action' });
      }

      try {
        const result = await this.bot.executor.execute({
          action,
          reasoning: 'Manual command',
          priority: 'high',
          estimatedTime: 30
        });
        res.json(result);
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });
  }

  start(port) {
    this.app.listen(port, () => {
      console.log(`🌐 Dashboard running at http://localhost:${port}`);
      console.log(`📊 Endpoints: /, /state, /history, POST /command\n`);
    });
  }
}

// === MAIN ===
async function main() {
  console.log('🚀 Advanced Minecraft Bedrock AI Bot v2.0\n');

  const bot = new MinecraftBot();
  const dashboard = new WebDashboard(bot);

  // Start web server
  dashboard.start(config.web.port);

  // Connect to Minecraft
  await bot.connect();

  // Handle graceful shutdown
  process.on('SIGINT', async () => {
    console.log('\n👋 Received shutdown signal');
    await bot.shutdown();
    process.exit(0);
  });

  // Start main AI loop
  await bot.mainLoop();
}

main().catch(error => {
  console.error('💥 Fatal error:', error);
  process.exit(1);
});
