import {LegacyEventArchive} from '../adapters/openclaw/legacy-event-archive.js';
import {logicalSessionKey} from '../adapters/openclaw/session-metadata.js';
import {canonicalizeRuntimeEvent} from '../adapters/openclaw/canonical-events.js';
import type {DurableRuntimeEvent} from '@syengup/fridaynext-channel-kit';
import { DurableRunStore as SharedRunStore } from '@syengup/fridaynext-channel-kit/runtime/durable-run-store';
export * from '@syengup/fridaynext-channel-kit/runtime/durable-run-store';

// 旧宿主键的大小写约定只在 OpenClaw 边界保留；其他逻辑身份精确比较。
export class DurableRunStore extends SharedRunStore {
  private readonly archive: LegacyEventArchive;
  constructor(root: string) {
    super(root, { sessionIdentity: value => /^agent:/i.test(value) ? value.trim().toLowerCase() : value.trim(), postTerminalEvents: ['session-title', 'outbound.final_meta', 'outbound.media', 'deliver.final'] });
    this.archive = new LegacyEventArchive(root);
  }
  override appendRunEvent(runId:string,eventType:string,payload:Record<string,unknown>):DurableRuntimeEvent {
    const run=this.run(runId);
    if(run?.phase === "cancelled" && ["outbound.media","deliver.final"].includes(eventType)) {
      return this.eventsForRun(runId).filter(event=>event.eventType === "run.cancelled").at(-1)!;
    }
    if(run && (payload._sourceEventType || payload._sourceEventBatch)) {
      const runSeq=run.lastRunSeq+1;
      const envelope:DurableRuntimeEvent={protocolVersion:3,serverInstanceId:this.serverInstanceId,eventId:0,runId,sessionKey:run.sessionKey,agentId:run.agentId,runSeq,eventType,occurredAt:Date.now(),payload};
      const canonical=canonicalizeRuntimeEvent(envelope).payload;
      let owner=run;const visited=new Set<string>();
      while(owner.parentRunId && !visited.has(owner.runId)) {visited.add(owner.runId);const parent=this.run(owner.parentRunId);if(!parent) break;owner=parent;}
      const updates=canonical.updates as Array<{kind:string;data?:Record<string,unknown>}>;
      for(const update of updates ?? []) if(update.kind === "control") update.data={...update.data,sessionKey:logicalSessionKey(owner.sessionKey)};
      this.archive.save(runId,runSeq,payload);
      return super.appendRunEvent(runId,eventType,canonical);
    }
    return super.appendRunEvent(runId,eventType,payload);
  }
  legacyEvent(event:DurableRuntimeEvent):DurableRuntimeEvent {return this.archive.restore(event);}
  claimQueuedAnswerRun(runId: string) { return this.claimQueuedControlResponse(runId); }
}
