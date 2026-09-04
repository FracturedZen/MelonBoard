package com.melonboard.mixin;

import com.melonboard.Overlay;
import net.minecraft.client.DeltaTracker;
import net.minecraft.client.gui.GuiGraphicsExtractor;
import net.minecraft.client.gui.Hud;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

/**
 * Draws the stats panel after the vanilla HUD.
 *
 * 26.2 has no {@code Gui.render}; the HUD is built by recording draw calls into a render state,
 * so this hooks {@code Hud.extractRenderState} instead. TAIL puts our panel on top of the vanilla
 * elements without disturbing any of them.
 */
@Mixin(Hud.class)
public class HudMixin {

    @Inject(method = "extractRenderState", at = @At("TAIL"))
    private void melonboard$overlay(GuiGraphicsExtractor g, DeltaTracker delta, CallbackInfo ci) {
        // F1 hides the HUD. 26.2 has no Options.hideGui, but the Hud knows its own state -- and
        // this mixin is the Hud, so the check belongs here rather than in Overlay.
        if (((Hud) (Object) this).isHidden()) return;

        Overlay.render(g);
    }
}
