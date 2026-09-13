import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { DurableRunStore, DurableRuntimeEvent } from "../runtime-v3/durable-run-store.js";
import { getRuntimeV3Store, resolveRuntimeV3Root } from "../runtime-v3/runtime-store.js";

export const PUSH_ORIGIN = "https://gw.syengup.host";
type Kind = "completed" | "failed" | "approval" | "question";
export type PushEvent = { kind: Kind; serverInstanceId: string; sessionKey: string; runId: string; agentId: string; requestId?: string; occurredAt: number; expiresAt: number };
type Registration = { deviceId: string; profileId: string; registrationId: string; pushGrant: string; cursor: number };
type Job = { deviceId: string; event: PushEvent; id: string; nextAt: number; attempts: number };
type State = { registrations: Record<string, Registration>; jobs: Record<string, Job>; handled: Record<string, number>; cancelled: Record<string, number>; cancellations: Record<string, {deviceId:string;id:string;expiresAt:number;nextAt:number}> };
const obj = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
export function pushIdentity(profileId: string, event: PushEvent): string {
  return "session." + crypto.createHash("sha256").update(JSON.stringify([profileId, event.serverInstanceId, event.kind === "failed" ? "completed" : event.kind, event.requestId || event.runId])).digest("hex");
}
export function pushCandidates(wire: DurableRuntimeEvent): Array<{ event: PushEvent; terminal: boolean }> {
  const common = { serverInstanceId: wire.serverInstanceId, sessionKey: wire.sessionKey, runId: wire.runId, agentId: wire.agentId, occurredAt: wire.occurredAt };
  if (["run.completed", "run.failed"].includes(wire.eventType)) {
    if (wire.parentRunId || /:(subagent|cron):|:heartbeat$/i.test(wire.sessionKey)) return [];
    return [{ event: { ...common, kind: wire.eventType === "run.failed" ? "failed" : "completed", expiresAt: wire.occurredAt + 86400000 }, terminal: false }];
  }
  const p = obj(wire.payload);
  const sources = Array.isArray(p._sourceEventBatch) ? p._sourceEventBatch.map(obj) : [{ type: p._sourceEventType, data: p._sourceEventData }];
  if (!p._sourceEventType && !Array.isArray(p._sourceEventBatch)) {
    for (const type of ["approval","question"]) if (wire.eventType.startsWith(type+".")) sources.push({type,data:{...p,op:wire.eventType.slice(type.length+1)}});
  }
  const result: Array<{ event: PushEvent; terminal: boolean }> = [];
  for (const source of sources) {
    const data = obj(source.data);
    let kind: Kind; let requestId: unknown; let terminal = false;
    if (source.type === "approval" || source.type === "question") {
      kind = source.type;
      requestId = data[kind === "approval" ? "approvalId" : "questionId"];
      terminal = ["resolved", "expired", "cancelled"].includes(String(data.op));
      if (!terminal && data.op !== "request") continue;
    } else if (source.type === "deliver") {
      kind = "question";
      requestId = obj(obj(obj(data.payload).channelData).askUser).questionId;
    } else continue;
    if (typeof requestId !== "string" || !requestId) continue;
    const expiry = typeof data.expiresAtMs === "number" ? data.expiresAtMs : wire.occurredAt + 3600000;
    result.push({ event: { ...common, kind, requestId, expiresAt: Math.min(expiry, wire.occurredAt + 3600000) }, terminal });
  }
  return result;
}

export class PushRuntime {
  private state: State;
  private busy = false;
  constructor(private file: string, private store: DurableRunStore,
    private post: (grant: string, event: PushEvent) => Promise<number> = async (pushGrant, event) => {
      const response = await fetch(PUSH_ORIGIN + "/v1/push/events", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({pushGrant,event}), signal: AbortSignal.timeout(10000) });
      return response.status;
    }, private now = Date.now, private cancelPost: (grant:string,id:string) => Promise<number> = async (pushGrant,notificationId) => {
      const response = await fetch(PUSH_ORIGIN + "/v1/push/cancel", {method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({pushGrant,notificationId}),signal:AbortSignal.timeout(10000)});
      return response.status;
    }) {
    this.state = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file,"utf8")) as State : { registrations: {}, jobs: {}, handled: {}, cancelled: {}, cancellations: {} };
    this.state.cancellations ??= {};
    for (const r of Object.values(this.state.registrations)) store.setPushCursor(r.deviceId, r.cursor);
  }
  private save(): void {
    fs.mkdirSync(path.dirname(this.file), {recursive:true});
    const fd = fs.openSync(this.file + ".tmp", "w", 0o600);
    try { fs.writeFileSync(fd,JSON.stringify(this.state)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(this.file + ".tmp",this.file);
  }
  register(input: Omit<Registration,"cursor">): void {
    const old = this.state.registrations[input.deviceId];
    const cursor = old?.cursor ?? this.store.eventHead(input.deviceId);
    this.store.setPushCursor(input.deviceId,cursor);
    this.state.registrations[input.deviceId] = {...input,cursor}; this.save();
  }
  remove(deviceId: string): void {
    delete this.state.registrations[deviceId];
    for (const [key,job] of Object.entries(this.state.jobs)) if (job.deviceId === deviceId) delete this.state.jobs[key];
    this.save(); this.store.setPushCursor(deviceId,null);
  }
  handled(deviceId: string, id: string): void {
    const key = deviceId + ":" + id;
    this.state.handled[key] = this.now() + 86400000; delete this.state.jobs[key];
    if (this.state.registrations[deviceId]) this.state.cancellations[key] = {deviceId,id,expiresAt:this.now()+86400000,nextAt:this.now()};
    this.save();
  }
  cancel(runId: string): void {
    this.state.cancelled[runId] = this.now() + 86400000;
    for (const r of Object.values(this.state.registrations)) {
      for (const wire of this.store.eventsForRun(runId)) {
        const run = this.store.run(runId);
        if (!run || !(run.deliveryDeviceIds ?? [run.deviceId]).includes(r.deviceId)) continue;
        for (const {event} of pushCandidates(wire)) this.handled(r.deviceId,pushIdentity(r.profileId,event));
      }
    }
    this.save();
  }
  async tick(): Promise<void> {
    if (this.busy) return; this.busy = true;
    try {
      let changed = false;
      for (const r of Object.values(this.state.registrations)) {
        if (this.store.eventHead(r.deviceId) <= r.cursor) continue;
        for (const wire of this.store.eventsAfter(r.deviceId,r.cursor,1000)) {
          for (const candidate of pushCandidates(wire)) {
            const id = pushIdentity(r.profileId,candidate.event); const key = r.deviceId + ":" + id;
            if (candidate.terminal) this.handled(r.deviceId,id);
            else if (!this.state.handled[key] && !this.state.jobs[key]) this.state.jobs[key] = {deviceId:r.deviceId,event:candidate.event,id,nextAt:wire.occurredAt+1000,attempts:0};
          }
          r.cursor = wire.eventId; changed = true;
        }
        if (changed) { this.save(); this.store.setPushCursor(r.deviceId,r.cursor); }
      }
      for (const [key,item] of Object.entries(this.state.cancellations)) {
        const r = this.state.registrations[item.deviceId];
        if (!r || item.expiresAt <= this.now()) { delete this.state.cancellations[key]; changed = true; continue; }
        if (item.nextAt > this.now()) continue;
        let status = 503; try { status = await this.cancelPost(r.pushGrant,item.id); } catch { /* 下次重试 */ }
        if ((status >= 200 && status < 300) || status === 403) delete this.state.cancellations[key];
        else item.nextAt = this.now()+30000;
        changed = true;
      }
      for (const [key,job] of Object.entries(this.state.jobs)) {
        const r = this.state.registrations[job.deviceId];
        if (job.nextAt > this.now()) continue;
        if (!r || this.state.handled[key] || this.state.cancelled[job.event.runId] || !this.store.run(job.event.runId) || job.event.expiresAt <= this.now()) { delete this.state.jobs[key]; changed = true; continue; }
        let status: number; try { status = await this.post(r.pushGrant,job.event); } catch { status = 503; }
        if (status >= 200 && status < 300) { delete this.state.jobs[key]; this.state.handled[key] = job.event.expiresAt; }
        else if (status === 403) this.remove(job.deviceId);
        else if (status === 429 || status >= 500) { job.attempts++; job.nextAt = this.now()+Math.min(300000,1000*2**Math.min(job.attempts,9)); }
        else { delete this.state.jobs[key]; console.error("[push] invalid_event", status); }
        changed = true; this.save();
      }
      for (const map of [this.state.handled,this.state.cancelled]) for (const [key,expiry] of Object.entries(map)) if (expiry < this.now()) { delete map[key]; changed = true; }
      if (changed) this.save();
    } finally { this.busy = false; }
  }
}
let active: {root:string;value:PushRuntime} | undefined;
export function getPushRuntime(): PushRuntime {
  const root = resolveRuntimeV3Root();
  if (!active || active.root !== root) active = {root,value:new PushRuntime(path.join(root,"push-state.json"),getRuntimeV3Store())};
  return active.value;
}
let timer: ReturnType<typeof setInterval> | undefined;
export function startPushRuntime(): void {
  if (timer) return;
  timer = setInterval(() => { void getPushRuntime().tick().catch(() => console.error("[push] queue_failed")); },250);
  timer.unref();
}
