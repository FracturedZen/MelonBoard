# Builds assets/thumbs/ from assets/cards/.
#
# WHY THESE EXIST
# ---------------
# Discord crops the images in a merged gallery to fill uniform, roughly square tiles. The card art
# is portrait (512x716), so in a gallery Discord keeps the middle and throws away the top and
# bottom -- which is exactly the part that says which card it is. /collection was unreadable for
# that reason.
#
# The fix is to hand Discord a SQUARE image, so there is nothing left for it to crop. Each card is
# padded, not scaled: the original 512x716 is blitted unchanged onto a 716x716 canvas with bars
# either side, so no resampling happens and no detail is lost. Card art already sits on a dark mat
# of #14101C -- 68 of the 77 files use exactly that at their corners -- so the bars are invisible
# and the card simply looks like it is sitting on its own background.
#
# Single-image embeds (the legendary announcement) are NOT cropped by Discord and keep the
# original portrait art from assets/cards/.
#
# Re-run after adding or changing a card:  .\assets\make-thumbs.ps1

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$src  = Join-Path $root "cards"
$dst  = Join-Path $root "thumbs"

New-Item -ItemType Directory -Force -Path $dst | Out-Null

# The deck's mat colour. Padding with it makes the bars indistinguishable from the card's own
# background rather than framing the card in a visible box.
$mat = [System.Drawing.Color]::FromArgb(255, 0x14, 0x10, 0x1C)

$made = 0
foreach ($file in Get-ChildItem (Join-Path $src "*.png")) {
    $card = New-Object System.Drawing.Bitmap $file.FullName
    try {
        # Square on the LONGER edge, so the card is never scaled down to fit.
        $side = [Math]::Max($card.Width, $card.Height)
        $out = New-Object System.Drawing.Bitmap $side, $side
        $g = [System.Drawing.Graphics]::FromImage($out)
        try {
            $g.Clear($mat)
            # Straight blit at native size -- no interpolation, so the output is pixel-identical
            # to the source in the region the card occupies.
            $g.DrawImageUnscaled($card, [int](($side - $card.Width) / 2), [int](($side - $card.Height) / 2))
        } finally {
            $g.Dispose()
        }

        $out.Save((Join-Path $dst $file.Name), [System.Drawing.Imaging.ImageFormat]::Png)
        $out.Dispose()
        $made++
    } finally {
        $card.Dispose()
    }
}

"$made thumbnails written to $dst"
