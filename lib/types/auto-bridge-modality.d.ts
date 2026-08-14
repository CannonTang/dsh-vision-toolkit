/**
 * Runtime patch that adds image modality to text-only models so the apiproxy
 * image gate admits pasted images. Installed only while autoBridge is enabled;
 * the returned disposer restores the exact original method.
 * @module dsh-vision-toolkit/auto-bridge-modality
 */
export declare function installImageModalityPatch(llm: {
    resolveModelInfo: Function;
}): () => void;
//# sourceMappingURL=auto-bridge-modality.d.ts.map