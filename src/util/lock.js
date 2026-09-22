// 串行化写操作：事件溯源的"校验—追加"之间存在 await（落盘 fsync），
// 同一批次的并发录入必须表现为原子事务，避免读后写交错产生重复身份。
export function createLock() {
  let tail = Promise.resolve();
  return function withLock(task) {
    const run = tail.then(task, task);
    // 防止单个任务失败中断后续任务排队
    tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };
}
