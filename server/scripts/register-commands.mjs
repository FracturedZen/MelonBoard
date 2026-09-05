/**
 * Registers MelonBoard's slash commands with Discord.
 *
 * Run again whenever the definitions below change:
 *
 *   DISCORD_APP_ID=... DISCORD_BOT_TOKEN=... DISCORD_GUILD_ID=... node scripts/register-commands.mjs
 *
 * ALWAYS PASS DISCORD_GUILD_ID. Global commands take up to an hour to appear, which means a new
 * command looks simply missing for most of that time; guild-scoped ones appear at once. This bot
 * serves one server, so there is nothing to gain from global registration and an hour to lose.
 *
 * Register guild commands BEFORE clearing globals if both exist -- a name registered in both
 * scopes shows up twice in the picker, and clearing globals first leaves a gap with no commands
 * at all.
 */

const APP_ID = process.env.DISCORD_APP_ID;
const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const GUILD_ID = process.env.DISCORD_GUILD_ID;

if (!APP_ID || !BOT_TOKEN) {
  console.error("Set DISCORD_APP_ID and DISCORD_BOT_TOKEN in the environment first.");
  process.exit(1);
}

const commands = [
  {
    name: "leaderboard",
    description: "Show the melon leaderboard",
    options: [
      {
        name: "page",
        description: "Which page of the standings (15 players per page)",
        type: 4, // INTEGER
        required: false,
        min_value: 1,
      },
    ],
  },
  {
    name: "link",
    description: "Link your Discord account to your Minecraft account",
  },
  {
    name: "combine",
    description: "Turn cards into a poker-hand set",
  },
  {
    name: "sets",
    description: "See the sets you have made",
  },
  {
    name: "trade",
    description: "Offer a trade to another player",
    options: [
      { name: "player", description: "Who to trade with", type: 6, required: true },
      {
        name: "give",
        description: "What you give, e.g. 3 of hearts x2, frac_1, 500 slices",
        type: 3,
        required: false,
      },
      {
        name: "want",
        description: "What you want back, same format",
        type: 3,
        required: false,
      },
    ],
  },
  {
    name: "open",
    description: "Open a melon card pack",
    options: [
      {
        name: "pay",
        description: "What to pay with (default: melon slices)",
        type: 3,
        required: false,
        choices: [
          { name: "melon slices (120)", value: "slices" },
          { name: "points (3,000)", value: "points" },
        ],
      },
    ],
  },
  {
    name: "collection",
    description: "See the cards you have collected",
  },
  {
    name: "pings",
    description: "Toggle pings for legendary and 1-of-1 pulls",
  },
  {
    name: "wallet",
    description: "Your points, melon slices and owned roles",
  },
  {
    name: "shop",
    description: "Browse cosmetic roles and see your balance",
  },
  {
    name: "buy",
    description: "Buy something from the melon shop",
    options: [
      {
        name: "item",
        description: "What to buy",
        type: 3,
        required: true,
        choices: [
          { name: "Melon Sprout (100k points)", value: "sprout" },
          { name: "Melon Farmer (1m points)", value: "farmer" },
          { name: "Melon Baron (10m points)", value: "baron" },
          { name: "Melon Tycoon (100m points)", value: "tycoon" },
          { name: "Melon Overlord (1b points)", value: "overlord" },
        ],
      },
    ],
  },
  {
    name: "lottery",
    description: "Melon giveaways",
    options: [
      {
        name: "create",
        description: "Start a giveaway (admins only)",
        type: 1, // SUB_COMMAND
        options: [
          { name: "prize", description: "What is being given away", type: 3, required: true },
          { name: "cost", description: "Cost per entry", type: 4, required: true, min_value: 1 },
          {
            name: "currency",
            description: "What entries are paid in",
            type: 3,
            required: true,
            choices: [
              { name: "points", value: "points" },
              { name: "melon slices", value: "slices" },
            ],
          },
          { name: "hours", description: "How long it runs (default 24)", type: 4, required: false, min_value: 1, max_value: 720 },
        ],
      },
      {
        name: "enter",
        description: "Buy entries into the current giveaway",
        type: 1,
        options: [
          { name: "entries", description: "How many entries to buy", type: 4, required: false, min_value: 1 },
        ],
      },
      {
        name: "info",
        description: "Show the current giveaway",
        type: 1,
      },
    ],
  },
  {
    name: "melonstats",
    description: "Look up one player's melon score",
    options: [
      {
        name: "player",
        description: "Minecraft username",
        type: 3, // STRING
        required: true,
      },
    ],
  },
];

const url = GUILD_ID
  ? `https://discord.com/api/v10/applications/${APP_ID}/guilds/${GUILD_ID}/commands`
  : `https://discord.com/api/v10/applications/${APP_ID}/commands`;

const res = await fetch(url, {
  method: "PUT", // PUT replaces the whole set, so removed commands actually disappear
  headers: {
    Authorization: `Bot ${BOT_TOKEN}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify(commands),
});

if (!res.ok) {
  console.error(`Failed (${res.status}):`, await res.text());
  process.exit(1);
}

console.log(`Registered ${commands.length} commands ${GUILD_ID ? `to guild ${GUILD_ID}` : "globally"}.`);
