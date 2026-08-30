export function createConcurrentQueue({ concurrency = 1, onTaskError = null } = {}) {
  const limit = Math.max(1, Math.floor(Number(concurrency) || 1));
  const pending = [];
  let active = 0;
  let paused = false;

  function drain() {
    while (!paused && active < limit && pending.length > 0) {
      const task = pending.shift();
      active += 1;
      Promise.resolve()
        .then(task)
        .catch((error) => onTaskError?.(error))
        .finally(() => {
          active -= 1;
          drain();
        });
    }
  }

  return {
    enqueue(task) {
      if (typeof task !== 'function') throw new TypeError('Queue task must be a function.');
      pending.push(task);
      drain();
    },
    pause() {
      paused = true;
    },
    resume() {
      paused = false;
      drain();
    },
    stats() {
      return { concurrency: limit, active, pending: pending.length, paused };
    },
  };
}
