import type { Automation } from './schema'

const MINUTE = 60_000
const DAY = 24 * 60 * MINUTE
// 首次启用的定时任务只补跑最近 5 分钟内错过的时刻，避免刚保存就立即执行
const FIRST_RUN_GRACE_MS = 5 * MINUTE

type ScheduleFields = Pick<Automation, 'schedule' | 'intervalMin' | 'time' | 'weekdays' | 'lastRun'>

function parseTime(time: string): [number, number] {
  const [hour, minute] = time.split(':').map(Number)
  return [Number.isFinite(hour) ? hour : 9, Number.isFinite(minute) ? minute : 0]
}

function slotOn(dayMs: number, time: string): number {
  const date = new Date(dayMs)
  const [hour, minute] = parseTime(time)
  date.setHours(hour, minute, 0, 0)
  return date.getTime()
}

function allowedDay(item: ScheduleFields, ms: number): boolean {
  return item.schedule !== 'weekly' || item.weekdays.includes(new Date(ms).getDay())
}

export function latestSlot(item: ScheduleFields, now: number): number | null {
  for (let offset = 0; offset <= 7; offset++) {
    const slot = slotOn(now - offset * DAY, item.time)
    if (slot <= now && allowedDay(item, slot)) return slot
  }
  return null
}

export function nextRunAt(item: ScheduleFields, now: number): number | null {
  const last = item.lastRun ? Date.parse(item.lastRun) : NaN
  if (item.schedule === 'interval') return Number.isNaN(last) ? now : Math.max(now, last + item.intervalMin * MINUTE)
  for (let offset = 0; offset <= 8; offset++) {
    const slot = slotOn(now + offset * DAY, item.time)
    if (slot > now && allowedDay(item, slot)) return slot
  }
  return null
}

export function isDue(item: ScheduleFields, now: number): boolean {
  const last = item.lastRun ? Date.parse(item.lastRun) : NaN
  if (item.schedule === 'interval') return Number.isNaN(last) || now - last >= item.intervalMin * MINUTE
  const slot = latestSlot(item, now)
  if (slot === null) return false
  if (Number.isNaN(last)) return now - slot <= FIRST_RUN_GRACE_MS
  return last < slot
}

export function dueAutomations(automations: Automation[], now: number): Automation[] {
  return automations.filter((item) => item.enabled && isDue(item, now))
}

const weekdayNames = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

export function describeSchedule(item: ScheduleFields, intervalLabel: (minutes: number) => string): string {
  if (item.schedule === 'daily') return `每天 ${item.time}`
  if (item.schedule === 'weekly') {
    const days = [...item.weekdays].sort((a, b) => a - b)
    if (days.length === 7) return `每天 ${item.time}`
    const label = days.join() === '1,2,3,4,5' ? '工作日' : days.map((day) => weekdayNames[day]).join('、')
    return `每周${label} ${item.time}`
  }
  return intervalLabel(item.intervalMin)
}

export { weekdayNames }
