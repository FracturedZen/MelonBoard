# Set art — filenames

Every combinable hand has a **set key**, and its art is `assets/sets/<key>.png`.

Art is optional. A set with no image falls back to showing the cards that made it, so these can be
added a few at a time — nothing breaks while a file is missing.

Same spec as the cards: **512 × 716 PNG**.

## Ranks and suits, exactly as spelled in filenames

```
ranks   2 3 4 5 6 7 8 9 10 J Q K A
suits   clubs diamonds hearts spades
```

## The seven combinable hands

Three of a Kind and above. Pair and Two Pair are not combinable.

| Hand | Key format | Example | Count |
|---|---|---|---|
| Three of a Kind | `trips_<rank>` | `trips_9.png` | 13 |
| Straight | `straight_<highest>` | `straight_9.png` | 10 |
| Flush | `flush_<suit>` | `flush_hearts.png` | 4 |
| Full House | `full_house_<trips>_over_<pair>` | `full_house_K_over_7.png` | 156 |
| Four of a Kind | `quads_<rank>` | `quads_A.png` | 13 |
| Straight Flush | `straight_flush_<highest>_<suit>` | `straight_flush_9_hearts.png` | 36 |
| Royal Flush | `royal_flush_<suit>` | `royal_flush_spades.png` | 4 |
| | | **total** | **236** |

## Rules that decide the exact name

**Straight** — named by its **highest** card. `straight_9` is 5-6-7-8-9. The ace plays both ways:
`straight_A` is 10-J-Q-K-A, and `straight_5` is the wheel, A-2-3-4-5. That gives **10** straights,
5-high through A-high.

**Straight Flush** — same high-card naming, plus the suit: `straight_flush_9_clubs`. **9 per
suit**, 5-high through K-high, because the ace-high run in one suit is a Royal Flush instead.
9 x 4 = 36.

**Full House** — trips rank first, then `_over_`, then the pair rank. `full_house_3_over_A` is
three 3s and two aces, which is a different set from `full_house_A_over_3`.

**Rank `10`** is written `10`, not `T`.

## Suggested order to draw them

The rarest hands come up least often, so the common ones are worth having first:

1. `trips_*` (13) — seen constantly
2. `flush_*` (4) and `royal_flush_*` (4) — only 8 files, and the flashiest
3. `quads_*` (13) and `straight_*` (10)
4. `straight_flush_*` (36)
5. `full_house_*` (156) — the long tail, and two thirds of the whole job

The first 43 files cover the large majority of what anyone will actually make.

`FILENAMES.txt` in this folder is the authoritative list, generated from the same rules the
code uses, so it cannot drift from what the bot looks for.
