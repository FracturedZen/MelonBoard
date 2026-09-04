package com.melonboard.mixin;

import com.melonboard.AfkTracker;
import net.minecraft.core.BlockPos;
import net.minecraft.world.level.chunk.LevelChunk;
import net.minecraft.world.level.block.state.BlockState;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfoReturnable;

/**
 * Every block change in the world, which is how piston-broken melons are spotted.
 *
 * {@code setBlockState} returns the state that was there before, so injecting at RETURN gives both
 * halves of the transition without having to read the world again.
 *
 * This is a genuinely hot path -- it fires for every block update the client applies -- so the
 * handler's first act is a single reference comparison against MELON, and everything else happens
 * only for blocks that could possibly count.
 */
@Mixin(LevelChunk.class)
public class LevelChunkMixin {

    @Inject(method = "setBlockState", at = @At("RETURN"))
    private void melonboard$blockChanged(BlockPos pos, BlockState state, int flags,
                                         CallbackInfoReturnable<BlockState> cir) {
        LevelChunk self = (LevelChunk) (Object) this;

        // The merged jar means this class is shared with the integrated server; only the client
        // world is ours to watch.
        if (self.getLevel() == null || !self.getLevel().isClientSide()) return;

        BlockState previous = cir.getReturnValue();
        if (previous == null) return;

        AfkTracker.onBlockChanged(pos, previous, state);
    }
}
