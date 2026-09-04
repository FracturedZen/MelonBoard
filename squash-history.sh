#!/usr/bin/env bash
#
# Replaces the entire git history with a single commit and force-pushes it.
#
# WHY: the old history records the period when score verification was disabled, including the
# commits that introduced and then patched it. Squashing removes that record. The working tree is
# untouched -- only history changes.
#
# THIS IS IRREVERSIBLE. Once force-pushed, the old commits are gone from GitHub. Nothing else
# clones this repo, so there is nothing to break.
#
# Run from anywhere:  bash "C:/Users/Z/Desktop/MelonBoard/squash-history.sh"

set -e
cd "C:/Users/Z/Desktop/MelonBoard"

NAME="FracturedZen"
EMAIL="140035389+FracturedZen@users.noreply.github.com"

echo "Replacing $(git rev-list --count HEAD) commits with one."
echo "Working tree: $(git status --porcelain | wc -l) uncommitted change(s)."
echo

git checkout --orphan squashed
git add -A
git -c user.name="$NAME" -c user.email="$EMAIL" commit -m "MelonBoard

A melon leaderboard for a Minecraft server: a standalone Fabric mod reports a
player's melon statistics, and a Cloudflare Worker keeps the standings, serves
a Discord bot, and runs the shop, giveaways and economy.

The mod reads vanilla server-side statistics rather than watching packets, so
there is no client-side prediction to get wrong, nothing is double counted, and
a lost submission costs nothing -- the totals live on the server. Scoring
baselines are written once, server side, so everyone starts at zero.

Points have two meanings and conflating them would punish participation: the
leaderboard ranks lifetime points and never falls, while the shop charges a
separate spendable balance.

Clients send a protocol version and the API refuses anything older than it will
talk to, so a security change retires old builds at the door rather than
letting them continue on a weaker path.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"

git branch -D main
git branch -m main
git push -f origin main

echo
echo "Done. History is now:"
git log --oneline
