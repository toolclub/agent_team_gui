import type { KvTable } from '@deepseek-ai/dsh-storage-domain'

interface SnapshotEntry {
  restore(): Promise<void>
}

/**
 * Storage-domain exposes atomic single-key updates but no multi-table
 * transaction. This bounded unit-of-work snapshots only participating tables
 * and compensates in reverse order on failure.
 */
export class StorageUnitOfWork {
  private readonly snapshots: SnapshotEntry[] = []

  capture<K extends string, V>(table: KvTable<K, V>): void {
    const before = [...table.entries()]
    this.snapshots.push({
      async restore() {
        // Snapshot the live key list before deleting. Backends are free to
        // expose a live iterator whose cursor would otherwise skip rows while
        // the compensation mutates the table.
        for (const [key] of [...table.entries()]) await table.delete(key)
        for (const [key, value] of before) await table.put(key, value)
      },
    })
  }

  async run<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation()
    } catch (error: unknown) {
      const rollbackErrors: unknown[] = []
      for (const snapshot of [...this.snapshots].reverse()) {
        try { await snapshot.restore() } catch (rollbackError: unknown) { rollbackErrors.push(rollbackError) }
      }
      if (rollbackErrors.length > 0) {
        throw new AggregateError([error, ...rollbackErrors], 'storage operation and compensation both failed')
      }
      throw error
    }
  }
}
