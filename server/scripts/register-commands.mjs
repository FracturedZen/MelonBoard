/**
 * Registers MelonBoard's slash commands with Discord.
 *
 * Run once after deploying, and again whenever the command definitions below change:
 *
 *   DISCORD_APP_ID=... DISCORD_BOT_TOKEN=... node scripts/register-commands.mjs
 *
 * Global commands can take up to an hour to appear. To iterate faster, also pass
 * DISCORD_GUILD_ID and they register instantly for that one server.
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
