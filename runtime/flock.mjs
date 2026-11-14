// Stand-in for @deepseek-ai/node-addon-system/flock: calls libc flock(2) through koffi, which dsh already
// depends on. LOCK_NB never blocks, so a synchronous call is fine and errno can be read right after it.
import { createRequire } from "node:module";
import { getSystemErrorName } from "node:util";

const LOCK_EX = 2;
const LOCK_NB = 4;
let koffi;
let flock;

function load() {
  if (flock) return;
  const base = new URL(import.meta.url).searchParams.get("base");
  koffi = createRequire(base)("koffi");
  flock = koffi.load("libc.so").func("int flock(int fd, int op)");
}

export async function tryLockExclusive(fd) {
  load();
  if (flock(fd, LOCK_EX | LOCK_NB) === 0) return;
  const errno = koffi.errno();
  const code = getSystemErrorName(-errno);
  throw Object.assign(new Error(`${code}: flock failed`), { code, errno, syscall: "flock" });
}
