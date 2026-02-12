'use client'

export function LocalTime({ date }: { date: string }) {
  return <>{new Date(date).toLocaleString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true
  })}</>
}