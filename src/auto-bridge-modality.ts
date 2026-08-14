/**
 * Runtime patch that adds image modality to text-only models so the apiproxy
 * image gate admits pasted images. Installed only while autoBridge is enabled;
 * the returned disposer restores the exact original method.
 * @module dsh-vision-toolkit/auto-bridge-modality
 */

interface ModelInfo {
  provider: string
  id: string
  name: string
  inputModalities?: string[]
}

function wrap(info: ModelInfo): ModelInfo {
  if (info.inputModalities !== void 0 && !info.inputModalities.includes('image')) {
    return { ...info, inputModalities: [...info.inputModalities, 'image'] }
  }
  return info
}

export function installImageModalityPatch(llm: { resolveModelInfo: Function }): () => void {
  const original = llm.resolveModelInfo
  if (typeof original !== 'function') throw new Error('llm.resolveModelInfo is not a function')
  const patched = async function (provider: string, model: string, signal?: AbortSignal): Promise<ModelInfo> {
    return wrap(await original.call(llm, provider, model, signal))
  }
  let restore: (() => void) | undefined
  try {
    llm.resolveModelInfo = patched
    if (llm.resolveModelInfo === patched) {
      restore = () => { llm.resolveModelInfo = original }
    }
  } catch { /* fall through to prototype patch */ }
  if (restore === undefined) {
    const proto = Object.getPrototypeOf(llm) as { resolveModelInfo?: Function }
    const originalProto = proto.resolveModelInfo
    if (typeof originalProto !== 'function') throw new Error('cannot patch llm.resolveModelInfo (instance or prototype)')
    proto.resolveModelInfo = function (this: unknown, provider: string, model: string, signal?: AbortSignal) {
      return Promise.resolve(originalProto.call(this, provider, model, signal)).then(wrap)
    }
    restore = () => { proto.resolveModelInfo = originalProto }
  }
  return restore
}
