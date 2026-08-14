/**
 * Runtime patch that adds image modality to text-only models so the apiproxy
 * image gate admits pasted images. Installed only while autoBridge is enabled;
 * the returned disposer restores the exact original method.
 *
 * SCOPE (differs from the design promise of "target provider/model only"):
 * the patch wraps `llm.resolveModelInfo` process-wide, so EVERY model whose
 * `inputModalities` omits `image` gains it — regardless of provider or model
 * id. This is acceptable for the current single-provider (deepseek)
 * deployment, where no other text-only provider runs alongside; a
 * multi-provider deployment MUST add a provider/model allowlist inside
 * `wrap` before enabling the bridge.
 * @module dsh-vision-toolkit/auto-bridge-modality
 */
export declare function installImageModalityPatch(llm: {
    resolveModelInfo: Function;
}): () => void;
//# sourceMappingURL=auto-bridge-modality.d.ts.map