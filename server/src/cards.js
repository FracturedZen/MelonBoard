/**
 * The melon deck, its rarity tiers, and pack odds.
 *
 * Card keys are exactly the image filenames without the extension, so a card's art URL is derived
 * rather than mapped. Adding a card is then a matter of dropping in a PNG and naming it correctly;
 * there is no second list to keep in step.
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
  // Numbered cards. The label carries the print run, so a 5/5 and a 1/1 read differently
  // everywhere they appear without needing two separate tiers.
  unique: { label: "Numbered", colour: 0xe8536f, sell: 0 },
};

/**
 * Per-CARD probabilities. A pack is six independent draws, so the per-pack chance of seeing at
 * least one is 1 - (1 - p)^6 -- which is what the requested odds refer to.
 *
 *   legendary  1/6000 per card   -> about 1 in 1000 packs
 *   unique     1/30000 per card  -> about 1 in 5000 packs
 *
 * Anything not caught by these falls through to the common pool.
 */
export const ODDS = {
  unique: 1 / 30000,
  legendary: 1 / 6000,
  epic: 0.02,
  rare: 0.13,
};

export const CARDS_PER_PACK = 6;

/** Builds the deck once. Keys match filenames exactly. */
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

export const DECK = buildDeck();
export const BY_KEY = new Map(DECK.map((c) => [c.key, c]));

const POOL = {
  common: DECK.filter((c) => c.rarity === "common"),
  rare: DECK.filter((c) => c.rarity === "rare"),
  epic: DECK.filter((c) => c.rarity === "epic"),
  legendary: DECK.filter((c) => c.rarity === "legendary"),
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

/**
 * Draws one card.
 *
 * When no numbered copies remain the branch is skipped entirely rather than rolling for something
 * that cannot be given, so the other tiers' odds are not quietly inflated by a dead branch.
 *
 * @param uniques entries of {key, remaining} for numbered cards with copies left.
 * @param extras  bought cards by tier, {rare: [...], epic: [...], legendary: [...]}. These join
 *                their tier's pool for the pick, so the TIER's odds are untouched and the extra
 *                card is simply one more equally likely outcome inside it. That is what makes a
 *                bought card endless: no supply to exhaust, same odds forever.
 *
 * The pick is weighted by remaining copies, so a card with five prints is five times likelier to
 * appear than a one-of-one. Weighting by card instead would make a 1/1 exactly as common as a
 * 5/5, which defeats the point of printing five.
 */
export function drawCard(uniques = [], extras = {}) {
  const roll = Math.random();

  const supply = uniques.reduce((n, u) => n + u.remaining, 0);
  if (supply > 0 && roll < ODDS.unique) {
    let ticket = Math.floor(Math.random() * supply);
    for (const u of uniques) {
      ticket -= u.remaining;
      if (ticket < 0) {
        return { key: u.key, rarity: "unique", name: prettyKey(u.key), unique: true };
      }
    }
  }

  if (roll < ODDS.unique + ODDS.legendary) return pickFrom(poolFor("legendary", extras));
  if (roll < ODDS.unique + ODDS.legendary + ODDS.epic) return pickFrom(poolFor("epic", extras));
  if (roll < ODDS.unique + ODDS.legendary + ODDS.epic + ODDS.rare) return pickFrom(poolFor("rare", extras));

  return pickFrom(poolFor("common", extras));
}

/** A tier's deck cards plus any bought ones, without mutating the built-in pool. */
function poolFor(tier, extras) {
  const extra = extras?.[tier];
  return extra && extra.length ? POOL[tier].concat(extra) : POOL[tier];
}

/** "frac_1_holo" -> "Frac 1 Holo". */
export function prettyKey(key) {
  return key.split("_").map((w) => w[0].toUpperCase() + w.slice(1)).join(" ");
}

function pickFrom(pool) {
  return pool[Math.floor(Math.random() * pool.length)];
}

/** True for the tiers that deserve an announcement and a ping. */
export function isNoteworthy(rarity) {
  return rarity === "legendary" || rarity === "unique";
}
