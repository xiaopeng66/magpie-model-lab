import { randomUUID } from "node:crypto";
import { invalid, safeError } from "./gateway.mjs";

export const MAX_DAILY_SLOTS = 24;

const formatters = new Map();
function wallTime(at, timeZone) {
  let formatter = formatters.get(timeZone);
  if (!formatter) { formatter = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }); formatters.set(timeZone, formatter); }
  const parts = Object.fromEntries(formatter.formatToParts(at).map(p => [p.type, p.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}`, minute: Number(parts.hour) * 60 + Number(parts.minute) };
}
const minutes = value => Number(value.slice(0, 2)) * 60 + Number(value.slice(3));
const shiftDate = (date, offset) => new Date(Date.parse(`${date}T00:00:00Z`) + offset * 86400000).toISOString().slice(0, 10);

export function dailyTimes(plan) {
  if (plan.mode === "times") {
    const times = [...new Set(plan.times)].sort();
    if (times.length > MAX_DAILY_SLOTS) throw invalid(`每天 ${times.length} 次，最多 ${MAX_DAILY_SLOTS} 次`);
    return times.map(time => ({ time, offset: 0 }));
  }
  const start = plan.allDay ? 0 : minutes(plan.start), end = plan.allDay ? 1440 : minutes(plan.end);
  const duration = end > start ? end - start : 1440 - start + end;
  const count = Math.ceil(duration / plan.intervalMinutes);
  if (!Number.isSafeInteger(count) || count < 1) throw invalid("间隔需为正整数");
  if (count > MAX_DAILY_SLOTS) throw invalid(`每天 ${count} 次，最多 ${MAX_DAILY_SLOTS} 次；间隔至少 ${Math.ceil(duration / MAX_DAILY_SLOTS)} 分钟`);
  return Array.from({ length: count }, (_, index) => {
    const value = start + index * plan.intervalMinutes, clock = value % 1440;
    return { time: `${String(Math.floor(clock / 60)).padStart(2, "0")}:${String(clock % 60).padStart(2, "0")}`, offset: Math.floor(value / 1440) };
  });
}

function wallInstants(date, time, timeZone) {
  const target = Date.parse(`${date}T${time}:00Z`), offsets = new Set();
  // Sample both sides of a timezone transition; a repeated clock time still has one slot.
  for (const hours of [-36, -12, 0, 12, 36]) {
    const instant = target + hours * 3600000, local = wallTime(new Date(instant), timeZone);
    offsets.add(Date.parse(`${local.date}T${local.time}:00Z`) - instant);
  }
  return [...offsets].map(offset => target - offset).filter(instant => {
    const local = wallTime(new Date(instant), timeZone); return local.date === date && local.time === time;
  }).sort((a, b) => a - b);
}

function slotsForDate(plan, date) {
  if (!plan.days.includes(new Date(`${date}T00:00:00Z`).getUTCDay())) return [];
  return dailyTimes(plan).map(({ time, offset }) => {
    const localDate = shiftDate(date, offset), instant = wallInstants(localDate, time, plan.timeZone)[0];
    return { key: `${plan.id}:${plan.revision}:${localDate}:${time}`, time, label: `${offset ? "次日 " : ""}${time}`,
      localDate, at: instant === undefined ? null : new Date(instant).toISOString() };
  });
}

export function dailySlots(plan, at = new Date()) {
  const wall = wallTime(at, plan.timeZone);
  const overnight = plan.mode === "interval" && !plan.allDay && minutes(plan.end) < minutes(plan.start) && wall.minute < minutes(plan.end);
  const date = shiftDate(wall.date, overnight ? -1 : 0);
  return { date, timeZone: plan.timeZone, slots: slotsForDate(plan, date).map(slot => ({ ...slot,
    state: !slot.at ? "skipped" : !plan.enabled ? "paused" : Date.parse(slot.at) > at.getTime() ? "waiting" : "missed",
    ...(!slot.at ? { reason: "夏令时跳过了这个时刻" } : {}) })) };
}
function windowEnd(at, wall, remaining, timeZone) {
  const target = Date.parse(`${wall.date}T00:00:00Z`) + (wall.minute + remaining) * 60000;
  const first = Math.floor(at.getTime() / 60000) * 60000 + 60000;
  for (let time = first; time <= first + 2 * 86400000; time += 60000) {
    const local = wallTime(new Date(time), timeZone);
    if (Date.parse(`${local.date}T00:00:00Z`) + local.minute * 60000 >= target) return new Date(time).toISOString();
  }
  throw new Error("无法确定计划时间窗");
}

export function occurrence(plan, at) {
  if (!plan.enabled) return null;
  const wall = wallTime(at, plan.timeZone), day = new Date(`${wall.date}T00:00:00Z`);
  let remaining = 1440 - wall.minute;
  if (plan.mode === "interval") {
    const start = plan.allDay ? 0 : minutes(plan.start), end = plan.allDay ? 1440 : minutes(plan.end);
    const duration = end > start ? end - start : 1440 - start + end;
    let elapsed = wall.minute - start;
    if (elapsed < 0 && end <= start) { elapsed += 1440; day.setUTCDate(day.getUTCDate() - 1); }
    if (elapsed < 0 || elapsed >= duration || elapsed % plan.intervalMinutes !== 0) return null;
    remaining = duration - elapsed;
  } else if (!plan.times.includes(wall.time)) return null;
  if (!plan.days.includes(day.getUTCDay())) return null;
  const minute = wallInstants(wall.date, wall.time, plan.timeZone)[0];
  return { key: `${plan.id}:${plan.revision}:${wall.date}:${wall.time}`, at: new Date(minute).toISOString(),
    expiresAt: windowEnd(at, wall, remaining, plan.timeZone), local: `${wall.date} ${wall.time}`, plan };
}

export function nextOccurrences(plan, after, count = 3) {
  if (!plan.enabled) return [];
  const date = wallTime(after, plan.timeZone).date, candidates = [];
  for (let day = -1; day <= 8; day++) candidates.push(...slotsForDate(plan, shiftDate(date, day)));
  return candidates.filter(slot => slot.at && Date.parse(slot.at) > after.getTime()).sort((a, b) => a.at.localeCompare(b.at)).slice(0, count).map(slot => {
    const { plan: _, ...entry } = occurrence(plan, new Date(slot.at)); return entry;
  });
}

export class Scheduler {
  constructor(favorites, now = () => new Date()) {
    this.favorites = favorites; this.now = now; this.lastMinute = Math.floor(now().getTime() / 60000); this.pending = Promise.resolve(); this.closed = false;
  }
  start() { this.timer = setInterval(() => this.tick().catch(error => this.favorites.runner.emit("schedule-error", { error: safeError(error) })), 5000); this.timer.unref?.(); }
  tick(at = this.now()) {
    const task = this.pending.catch(() => {}).then(async () => {
      const minute = Math.floor(at.getTime() / 60000);
      if (this.closed || minute <= this.lastMinute) return;
      const missed = minute - this.lastMinute > 1; this.lastMinute = minute;
      this.favorites.runner.pump();
      if (missed || !this.favorites.state.enabled) return;
      const due = this.favorites.state.plans.map(plan => occurrence(plan, at)).filter(Boolean);
      if (!due.length) return;
      const claimed = await this.favorites.claim(due, at.toISOString()), targets = new Map(), roundId = randomUUID();
      for (const item of claimed) for (const id of item.plan.favoriteIds) for (const kind of item.plan.kinds) {
        const key = `${id}:${kind}`;
        if (!targets.has(key)) targets.set(key, { ids: [id], kinds: [kind], plans: [], expiresAt: item.expiresAt, scheduledAt: item.at });
        const target = targets.get(key); target.plans.push({ id: item.plan.id, revision: item.plan.revision, name: item.plan.name, triggerKey: item.key, expiresAt: item.expiresAt });
        if (item.expiresAt > target.expiresAt) target.expiresAt = item.expiresAt;
      }
      for (const target of targets.values()) {
        try {
          const result = await this.favorites.run(target, { source: "automatic", roundId, plans: target.plans, expiresAt: target.expiresAt, scheduledAt: target.scheduledAt });
          const error = result.errors.map(error => error.error).join("；");
          const run = result.runs[0] || result.linked[0];
          await this.favorites.setClaimOutcome(target.plans, run ? { state: "started", runId: run.id } : { state: "error", reason: error || "未能创建测试" });
          if (error) this.favorites.runner.emit("schedule-error", { error });
        } catch (error) {
          await this.favorites.setClaimOutcome(target.plans, { state: "error", reason: safeError(error) });
          this.favorites.runner.emit("schedule-error", { error: safeError(error) });
        }
      }
    });
    this.pending = task; return task;
  }
  async close() { this.closed = true; clearInterval(this.timer); await this.pending.catch(() => {}); }
}
