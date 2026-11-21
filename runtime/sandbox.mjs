// dsh's local sandbox has runner chains for linux, darwin and win32 only, so on Android (process.platform is
// "android") every confined command fails with SANDBOX_UNAVAILABLE. Android kernels enforce Landlock for apps:
// give android the linux chain (there is no bwrap, so the Landlock launcher built at install time wins the probe)
// and grant $TMPDIR where the Landlock profile grants /tmp, which apps cannot write.
import path from "node:path";

export const SANDBOX_LOCAL = "/@deepseek-ai/dsh-sandbox-local/lib/index.js";

const CHAIN = 'linux: ["bwrap", "landlock"],';
const TMP_GRANT = 'readWrite.push("/tmp", ';

// Returns the adapted source, or undefined when dsh changed this code (the sandbox then stays unavailable).
export function patchSandboxLocal(source) {
  if (!source.includes(CHAIN) || !source.includes(TMP_GRANT)) return undefined;
  const tmp = process.env.TMPDIR || path.join(process.env.PREFIX || "/data/data/com.termux/files/usr", "tmp");
  return source
    .replace(CHAIN, `${CHAIN} android: ["bwrap", "landlock"],`)
    .replace(TMP_GRANT, `readWrite.push(${JSON.stringify(tmp)}, `);
}
