import fs from "node:fs";

/**
 * Single-instance guard. Two runs at once would fight over the camera's one P2P session.
 * The lock holds our pid; a lock whose pid is dead is stale and reclaimed.
 */
export function acquireLock(file: string): () => void {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(file, "wx");
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      const release = (): void => {
        try {
          if (fs.readFileSync(file, "utf8").trim() === String(process.pid)) fs.unlinkSync(file);
        } catch {
          // already gone
        }
      };
      process.once("exit", release);
      return release;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      const pid = Number(fs.readFileSync(file, "utf8").trim());
      if (Number.isFinite(pid) && pid > 0 && pidAlive(pid)) {
        throw new LockHeldError(pid);
      }
      fs.unlinkSync(file); // stale
    }
  }
  throw new Error(`could not acquire lock ${file}`);
}

export class LockHeldError extends Error {
  readonly pid: number;
  constructor(pid: number) {
    super(`another eufy-snap run is in progress (pid ${pid})`);
    this.name = "LockHeldError";
    this.pid = pid;
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}
