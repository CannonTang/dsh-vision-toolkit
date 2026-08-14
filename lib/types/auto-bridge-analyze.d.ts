import type { VisionToolkitRuntime } from './runtime.ts';
/** Result of one attachment analysis: the glance answer, or a degradation reason. */
export type AnalyzeOutcome = {
    ok: true;
    answer: string;
} | {
    ok: false;
    reason: string;
};
/**
 * Shared attachment-byte image analyzer: stages incoming bytes in a temp
 * directory, then calls the runtime glance path with the staged file so the
 * auto bridge and the manual tools hit the exact same vision-provider call.
 */
export declare class ImageAnalyzer {
    #private;
    constructor(runtimeSource: () => VisionToolkitRuntime, options?: {
        language?: 'zh' | 'en';
    });
    /** Vision output language this analyzer was configured with. */
    get language(): 'zh' | 'en';
    /**
     * Analyze attachment bytes as one image. Writes `bytes` to a fresh temp
     * file, reuses runtime glance with no query (plain description mode), and
     * removes the temp directory before returning.
     *
     * The `name` attachment hint is accepted for forward compatibility but not
     * passed to glance yet.
     */
    analyze(bytes: Uint8Array, mediaType: string, name: string | undefined, signal?: AbortSignal): Promise<AnalyzeOutcome>;
}
//# sourceMappingURL=auto-bridge-analyze.d.ts.map