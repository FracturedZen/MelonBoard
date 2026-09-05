# Exports the live D1 database to a dated file OUTSIDE the working tree.
#
# WHY THIS EXISTS
# ---------------
# `limited_claims` is the only record of which numbered copy went to whom. A one-of-one cannot be
# recomputed from anything else -- not from the deck, not from the pull log, not from the mod. If
# the database goes, those cards go with it and there is no honest way to reissue them.
#
# WHY IT WRITES OUTSIDE THE REPO
# ------------------------------
# The dump contains Discord ids, Minecraft UUIDs and usernames. The repo is public. Those two
# facts must never meet, so the default destination is deliberately not a path inside the tree.
#
# NOTES
# -----
# * `wrangler d1 export` works with an OAuth login. (`d1 execute --file` does NOT -- it fails with
#   "Authentication error [code: 10000]" -- so do not assume the same of every d1 subcommand.)
# * The export makes the database briefly unavailable to queries, so run it by hand or daily,
#   not on a tight schedule.
#
# Usage:  .\server\scripts\backup.ps1  [-Dest <folder>]

param([string]$Dest = "$HOME\Desktop\MelonBoard-backups")

$ErrorActionPreference = "Stop"

New-Item -ItemType Directory -Force -Path $Dest | Out-Null
$out = Join-Path $Dest ("melonboard-{0}.sql" -f (Get-Date -Format "yyyy-MM-dd-HHmm"))

# wrangler needs to run where wrangler.toml is.
Push-Location (Join-Path $PSScriptRoot "..")
try {
    wrangler d1 export melonboard --remote --output $out
} finally {
    Pop-Location
}

if (Test-Path $out) {
    "Backed up to {0} ({1:N0} bytes)" -f $out, (Get-Item $out).Length

    # Keep the most recent 20. A dump is tens of kilobytes, so history is nearly free and a
    # tidy-up that threw away the only good copy would defeat the whole point.
    Get-ChildItem $Dest -Filter "melonboard-*.sql" |
        Sort-Object Name -Descending |
        Select-Object -Skip 20 |
        Remove-Item -Force
} else {
    throw "wrangler reported no error but produced no file at $out"
}
