// Camera and library pickers temporarily close SQLCipher on iOS. Keep short
// database operations out of that window without pausing in-flight uploads.
export class DatabaseActivityGate {
  private active = 0;
  private holds = 0;
  private readonly resumeWaiters: Array<() => void> = [];
  private readonly idleWaiters: Array<() => void> = [];

  async run<T>(operation: () => Promise<T>): Promise<T> {
    while (this.holds > 0 || this.active > 0) {
      await new Promise<void>((resolve) => this.resumeWaiters.push(resolve));
    }
    this.active += 1;
    try {
      return await operation();
    } finally {
      this.active -= 1;
      if (this.active === 0) {
        for (const resolve of this.idleWaiters.splice(0)) resolve();
        if (this.holds === 0) {
          for (const resolve of this.resumeWaiters.splice(0)) resolve();
        }
      }
    }
  }

  async pause(): Promise<() => void> {
    this.holds += 1;
    if (this.active > 0) {
      await new Promise<void>((resolve) => this.idleWaiters.push(resolve));
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.holds -= 1;
      if (this.holds === 0) {
        for (const resolve of this.resumeWaiters.splice(0)) resolve();
      }
    };
  }
}
