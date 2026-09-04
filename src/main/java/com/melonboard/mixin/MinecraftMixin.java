package com.melonboard.mixin;

import com.melonboard.MelonBoard;
import net.minecraft.client.Minecraft;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

/**
 * The mod's only heartbeat.
 *
 * Fabric API's ClientTickEvents would do the same job, but depending on Fabric API would mean
 * every player who wants on the leaderboard has to install a second jar. One four-line mixin is
 * a better trade when the whole point is that joining should be frictionless.
 */
@Mixin(Minecraft.class)
public class MinecraftMixin {

    @Inject(method = "tick", at = @At("TAIL"))
    private void melonboard$tick(CallbackInfo ci) {
        MelonBoard board = MelonBoard.get();
        if (board != null) board.clientTick((Minecraft) (Object) this);
    }
}
