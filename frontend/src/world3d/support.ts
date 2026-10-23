let gl: boolean | null = null;

/** WebGL2 available? (The 3D Room needs it for the MSAA render target; otherwise the Explorer stays 2D.) Memoised. */
export function hasWebGL(): boolean {
  if (gl != null) return gl;
  try {
    const c = document.createElement("canvas");
    const ctx = c.getContext("webgl2");
    gl = !!ctx;
    (ctx?.getExtension("WEBGL_lose_context") as { loseContext?: () => void } | null)?.loseContext?.();
  } catch {
    gl = false;
  }
  return gl;
}
