/**
 * The melon deck, the user deck, their rarity tiers and pack odds.
 *
 * Card keys are exactly the image filenames without the extension, so a card's art URL is derived
 * rather than mapped. Adding a card is then a matter of dropping in a PNG and naming it correctly;
 * there is no second list to keep in step.
 *
 * TWO PACKS, TWO POOLS. The melon pack is the playing-card deck and nothing else -- every card in
 * it is endless. The user pack is people and Minecraft lore, and is the only place anything scarce
 * lives. They share no cards, so a pull tells you which pack it came from.
 */

export const RANKS = ["2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K", "A"];
export const SUITS = ["clubs", "diamonds", "hearts", "spades"];

/** Where the art lives. Committed to the repo, served by GitHub's CDN. */
export const ART_BASE =
  "https://raw.githubusercontent.com/FracturedZen/MelonBoard/main/assets";

export const RARITY = {
  common: { label: "Common", colour: 0x8a8a8a, sell: 10 },
  rare: { label: "Rare", colour: 0x3ba55d, sell: 40 },
  epic: { label: "Epic", colour: 0x8b5cf6, sell: 150 },
  legendary: { label: "Legendary", colour: 0xf2a93b, sell: 1000 },
  // One-of-ones. The label carries the print run, so a 1/1 reads differently everywhere it
  // appears without needing a tier of its own.
  unique: { label: "Numbered", colour: 0xe8536f, sell: 0 },
};

/**
 * Per-CARD probabilities for the MELON pack, which is the playing-card deck only.
 *
 * A pack is six independent draws, so the per-pack chance of seeing at least one is
 * 1 - (1 - p)^6 -- which is what the requested odds refer to.
 *
 *   legendary  1/6000 per card   -> about 1 in 1000 packs
 *
 * Anything not caught by these falls through to the common pool. There is no numbered tier here
 * any more: everything scarce moved to the user pack.
 */
export const ODDS = {
  legendary: 1 / 6000,
  epic: 0.02,
  rare: 0.13,
};

/**
 * Per-CARD probabilities for the USER pack.
 *
 *   unique     1/1000 per card   -> about 1 in 167 packs
 *   legendary  1/50 per card     -> about 1 in 9 packs
 *
 * Legendary is far commoner here than in the melon pack on purpose -- it is nine cards belonging
 * to three people rather than a needle in a 58-card deck. That is also why a user-pack legendary
 * does not ping the announce role; see isNoteworthy.
 */
export const USER_ODDS = {
  unique: 1 / 1000,
  legendary: 0.02,
  rare: 0.33,
};

export const CARDS_PER_PACK = 6;

/** Builds the playing-card deck once. Keys match filenames exactly. */
function buildDeck() {
  const cards = [];

  for (const suit of SUITS) {
    for (const rank of RANKS) {
      const key = `${rank}_of_${suit}`;
      const rarity = rank === "A" ? "epic"
        : ["J", "Q", "K"].includes(rank) ? "rare"
        : "common";
      cards.push({ key, rank, suit, rarity, name: `${rank} of ${suit}` });
    }

    // The holographic ace is a separate collectible, not a variant of the plain one.
    cards.push({
      key: `A_of_${suit}_holo`,
      rank: "A",
      suit,
      rarity: "legendary",
      holo: true,
      name: `Holographic Ace of ${suit}`,
    });
  }

  cards.push({ key: "joker_gold", rank: null, suit: null, rarity: "legendary", name: "Gold Joker" });
  cards.push({ key: "joker_red", rank: null, suit: null, rarity: "legendary", name: "Red Joker" });

  return cards;
}

/**
 * People with cards in the user pack.
 *
 * `slug` is the key prefix and must match the PNG filenames, which are lower case. `name` is how
 * the card is written out -- kept separately because usernames carry casing a key cannot hold
 * ("hvh_1" is HvH #1, not "Hvh 1"), and prettyKey would mangle every one of them.
 *
 * `signature` marks the three whose cards are legendary in every pose and who have holo
 * one-of-ones. Adding a fourth is the flag plus the art.
 */
export const USER_PEOPLE = [
  { slug: "frac", name: "Frac", signature: true },
  { slug: "dumzy", name: "Dumzy", signature: true },
  { slug: "plutoren", name: "Plutoren", signature: true },
  { slug: "assassin73920", name: "Assassin73920" },
  { slug: "freezingcanoe9", name: "FreezingCanoe9" },
  { slug: "grikky", name: "Grikky" },
  { slug: "hvh", name: "HvH" },
  { slug: "lifeprojx", name: "LifeProjX" },
  { slug: "oteknova", name: "oTeknoVA" },
  { slug: "perrytheplatpyus", name: "perrytheplatpyus" },
  { slug: "shaybox", name: "ShayBox" },
  { slug: "sleepyfemboy", name: "SleepyFemboy" },
  { slug: "turbos52", name: "TurboS52" },
  { slug: "tylerthedev", name: "TylerTheDev" },
];

export const POSES_PER_PERSON = 3;

/** Minecraft lore cards: the common floor of the user pack, and its only cards without a person. */
export const LORE_CARDS = [
  { key: "book_dupe", name: "Book Dupe" },
  { key: "copper_golem", name: "Copper Golem" },
  { key: "creaking", name: "Creaking" },
  { key: "duper_trooper", name: "Duper Trooper" },
  { key: "fitmc", name: "FitMC" },
  { key: "happy_ghast", name: "Happy Ghast" },
  { key: "mister_epic", name: "Mister Epic" },
  { key: "salc1", name: "SalC1" },
  { key: "techno_potato_war", name: "Techno Potato War" },
  { key: "technoblade", name: "Technoblade" },
  { key: "trial_chamber", name: "Trial Chamber" },
  { key: "warden", name: "Warden" },
];

/**
 * Builds the user deck.
 *
 * The holo one-of-ones are listed here but are NOT in the draw pools: they are claimed through
 * limited_supply and limited_claims like any scarce card, and putting them in a pool as well
 * would make them both endless and scarce. They are here so /collection, /trade and the pull
 * announcement can all name and colour them from one place.
 */
function buildUserDeck() {
  const cards = LORE_CARDS.map((c) => ({ ...c, rarity: "common", user: true }));

  for (const p of USER_PEOPLE) {
    for (let pose = 1; pose <= POSES_PER_PERSON; pose++) {
      // The signature three are legendary in every pose. Everyone else gets two common poses and
      // one rare, so each person has a card worth chasing and the common tier stays varied --
      // twelve lore cards alone would mean seeing the same handful in every pack.
      const rarity = p.signature ? "legendary"
        : pose === POSES_PER_PERSON ? "rare"
        : "common";

      cards.push({
        key: `${p.slug}_${pose}`,
        rarity,
        user: true,
        person: p.slug,
        name: `${p.name} #${pose}`,
      });
    }

    if (!p.signature) continue;

    for (let pose = 1; pose <= POSES_PER_PERSON; pose++) {
      cards.push({
        key: `${p.slug}_${pose}_holo`,
        rarity: "unique",
        holo: true,
        user: true,
        person: p.slug,
        name: `${p.name} #${pose} Holo`,
      });
    }
  }

  return cards;
}

export const DECK = buildDeck();
export const USER_DECK = buildUserDeck();

/** Every card either pack can produce, by key. The two decks share no keys. */
export const BY_KEY = new Map([...DECK, ...USER_DECK].map((c) => [c.key, c]));

const POOL = {
  common: DECK.filter((c) => c.rarity === "common"),
  rare: DECK.filter((c) => c.rarity === "rare"),
  epic: DECK.filter((c) => c.rarity === "epic"),
  legendary: DECK.filter((c) => c.rarity === "legendary"),
};

/** The user pack's endless tiers. "unique" is absent on purpose -- see buildUserDeck. */
const USER_POOL = {
  common: USER_DECK.filter((c) => c.rarity === "common"),
  rare: USER_DECK.filter((c) => c.rarity === "rare"),
  legendary: USER_DECK.filter((c) => c.rarity === "legendary"),
};

export function artUrl(card) {
  return `${ART_BASE}/cards/${card.key}.png`;
}

/**
 * Square art, for galleries only.
 *
 * Discord CROPS the images in a merged gallery to fill uniform, roughly square tiles, and the card
 * art is portrait -- so it keeps the middle and discards the top and bottom, which is the part
 * that says which card it is. A square image gives it nothing to crop. Built by assets/make-thumbs.ps1
 * as the original padded (not scaled) onto a 716x716 mat, so the key stays the same in both places.
 *
 * A single-image embed is not cropped, so those still use artUrl.
 */
export function thumbUrl(card) {
  return `${ART_BASE}/thumbs/${card.key}.png`;
}

export function setArtUrl(setKey) {
  return `${ART_BASE}/sets/${setKey}.png`;
}

/** Draws one card from the melon pack. Every card in it is endless, so nothing can run out. */
export function drawCard() {
  const roll = Math.random();

  if (roll < ODDS.legendary) return pickFrom(POOL.legendary);
  if (roll < ODDS.legendary + ODDS.epic) return pickFrom(POOL.epic);
  if (roll < ODDS.legendary + ODDS.epic + ODDS.rare) return pickFrom(POOL.rare);

  return pickFrom(POOL.common);
}

/**
 * Draws one card from the user pack.
 *
 * When no one-of-one copies remain the branch is skipped entirely rather than rolling for
 * something that cannot be given, so the other tiers' odds are not quietly inflated by a dead
 * branch. The pack itself never runs dry: only the holo tier is finite.
 *
 * @param uniques entries of {key, remaining} for one-of-ones with copies left. The pick is
 *                weighted by remaining copies, so a card with five prints is five times likelier
 *                than a one-of-one -- which is the point of printing five.
 */
export function drawUserCard(uniques = []) {
  const roll = Math.random();

  const supply = uniques.reduce((n, u) => n + u.remaining, 0);
  if (supply > 0 && roll < USER_ODDS.unique) {
    let ticket = Math.floor(Math.random() * supply);
    for (const u of uniques) {
      ticket -= u.remaining;
      if (ticket < 0) {
        return {
          key: u.key,
          rarity: "unique",
          name: BY_KEY.get(u.key)?.name ?? prettyKey(u.key),
          unique: true,
        };
      }
    }
  }

  if (roll < USER_ODDS.unique + USER_ODDS.legendary) return pickFrom(USER_POOL.legendary);
  if (roll < USER_ODDS.unique + USER_ODDS.legendary + USER_ODDS.rare) return pickFrom(USER_POOL.rare);

  return pickFrom(USER_POOL.common);
}

/** "frac_1_holo" -> "Frac 1 Holo". The fallback for a key no deck knows about. */
export function prettyKey(key) {
  return key.split("_").map((w) => w[0].toUpperCase() + w.slice(1)).join(" ");
}

function pickFrom(pool) {
  return pool[Math.floor(Math.random() * pool.length)];
}

/**
 * True for the pulls that deserve an announcement and a ping.
 *
 * A one-of-one always qualifies. A legendary only does in the melon pack, where it is 1 in 1000
 * packs; the user pack's legendary tier is 1 in 9, and pinging the role that often would train
 * everyone to mute it.
 */
export function isNoteworthy(rarity, pack = "melon") {
  return rarity === "unique" || (pack === "melon" && rarity === "legendary");
}
