package com.melonboard.mixin;

import com.melonboard.AfkTracker;
import com.melonboard.Commands;
import com.melonboard.MelonBoard;
import net.minecraft.client.multiplayer.ClientPacketListener;
import net.minecraft.network.protocol.game.ClientboundBlockEventPacket;
import net.minecraft.world.level.block.Blocks;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

/**
 * Catches the mod's chat commands before they leave for the server.
 *
 * Registering a real client command would need Fabric API's command module; see
 * {@link MinecraftMixin} for why that dependency is not worth taking. The cost of doing it this
 * way is that another mod using the same prefix could swallow the message first, which is why
 * the prefix is configurable.
 */
@Mixin(ClientPacketListener.class)
public class ClientPacketListenerMixin {

    @Inject(method = "sendChat", at = @At("HEAD"), cancellable = true)
    private void melonboard$command(String message, CallbackInfo ci) {
        MelonBoard board = MelonBoard.get();
        if (board == null || board.config == null) return;

        if (Commands.handle(board, message)) ci.cancel();
    }

    /**
     * Piston fires arrive as block events. Recording them is what lets a melon turning to air be
     * attributed to a farm rather than to a player with a sword.
     */
    @Inject(method = "handleBlockEvent", at = @At("TAIL"))
    private void melonboard$blockEvent(ClientboundBlockEventPacket packet, CallbackInfo ci) {
        if (packet.getBlock() == Blocks.PISTON || packet.getBlock() == Blocks.STICKY_PISTON) {
            AfkTracker.onPistonFired(packet.getPos());
        }
    }
}
