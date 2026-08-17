import type { KeyboardEvent } from 'react'

/** WAI-ARIA horizontal tab keyboard behavior shared by Settings and Run Center. */
export function handleTabKey(event: KeyboardEvent<HTMLElement>): void {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
  const tabs = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
  if (tabs.length === 0) return
  const current = Math.max(0, tabs.indexOf(event.target as HTMLButtonElement))
  const next = event.key === 'Home' ? 0
    : event.key === 'End' ? tabs.length - 1
      : event.key === 'ArrowRight' ? (current + 1) % tabs.length
        : (current - 1 + tabs.length) % tabs.length
  event.preventDefault()
  tabs[next]?.focus()
  tabs[next]?.click()
}
