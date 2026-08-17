/**
 * Process-local FIFO critical section for multi-table compensated writes.
 * Storage-domain tables only promise atomic single-key updates; serializing
 * definition transactions prevents one rollback from erasing a later write.
 */
export class WriteCoordinator {
  private tail: Promise<void> = Promise.resolve()
  private revision = 0

  get currentRevision(): number { return this.revision }

  private async acquire(signal?: AbortSignal): Promise<() => void> {
    throwIfAborted(signal)
    let release!: () => void
    const predecessor = this.tail
    this.tail = new Promise<void>(resolve => { release = resolve })
    if (signal === undefined) {
      await predecessor
      return release
    }
    try {
      await new Promise<void>((resolve, reject) => {
        const onAbort = (): void => {
          cleanup()
          reject(signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason ?? 'operation aborted')))
        }
        const cleanup = (): void => { signal.removeEventListener('abort', onAbort) }
        signal.addEventListener('abort', onAbort, { once: true })
        predecessor.then(() => { cleanup(); resolve() }, (error: unknown) => { cleanup(); reject(error) })
      })
      throwIfAborted(signal)
      return release
    } catch (error: unknown) {
      // Keep the FIFO chain intact: a cancelled waiter releases its ticket as
      // soon as its predecessor finishes, without forcing the caller to wait.
      void predecessor.then(release, release)
      throw error
    }
  }

  async run<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const release = await this.acquire(signal)
    try {
      throwIfAborted(signal)
      const value = await operation()
      this.revision += 1
      return value
    } finally {
      release()
    }
  }

  /**
   * A read snapshot participates in the same FIFO. It waits for an in-flight
   * compensated write and prevents a later write from interleaving between
   * the individual table reads that form one logical definition graph.
   */
  read<T>(operation: () => T | Promise<T>, signal?: AbortSignal): Promise<T> {
    return this.readVersioned(operation, signal).then(result => result.value)
  }

  async readVersioned<T>(operation: () => T | Promise<T>, signal?: AbortSignal): Promise<{ value: T; revision: number }> {
    const release = await this.acquire(signal)
    try {
      throwIfAborted(signal)
      return { value: await operation(), revision: this.revision }
    } finally {
      release()
    }
  }
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted !== true) return
  if (signal.reason instanceof Error) throw signal.reason
  throw new Error(signal.reason === undefined ? 'operation aborted' : String(signal.reason))
}

/** Check cancellation both sides of an await so uncertain commits roll back. */
export async function abortableStep<T>(signal: AbortSignal | undefined, operation: () => Promise<T>): Promise<T> {
  throwIfAborted(signal)
  const value = await operation()
  throwIfAborted(signal)
  return value
}
