import fs from "node:fs";
import path from "node:path";
import {createHash} from "node:crypto";
import type {DurableRuntimeEvent} from "@syengup/fridaynext-channel-kit";

// 原生信封只保存在适配器归档中；公共账本的新记录只承载规范载荷。
export class LegacyEventArchive {
  private readonly events=new Map<string,Record<string,unknown>>();
  private readonly loaded=new Set<string>();
  constructor(private readonly root:string) {}
  private location(runId:string) {return path.join(this.root,"legacy-event-archive",createHash("sha256").update(runId).digest("hex")+".jsonl");}
  save(runId:string,runSeq:number,payload:Record<string,unknown>):void {
    fs.mkdirSync(path.dirname(this.location(runId)),{recursive:true});
    const fd=fs.openSync(this.location(runId),"a",0o600);
    try {fs.writeSync(fd,JSON.stringify({runSeq,payload})+"\n");fs.fsyncSync(fd);} finally {fs.closeSync(fd);}
    this.events.set(`${runId}:${runSeq}`,payload);
  }
  restore(event:DurableRuntimeEvent):DurableRuntimeEvent {
    if(!this.loaded.has(event.runId)) {
      this.loaded.add(event.runId);
      if(fs.existsSync(this.location(event.runId))) {
        const lines=fs.readFileSync(this.location(event.runId),"utf8").split("\n");
        for(const line of lines) {
          try {const saved=JSON.parse(line) as {runSeq:number;payload:Record<string,unknown>};this.events.set(`${event.runId}:${saved.runSeq}`,saved.payload);} catch { /* 未提交的尾行保留在原归档 */ }
        }
      }
    }
    return {...event,payload:this.events.get(`${event.runId}:${event.runSeq}`) ?? event.payload};
  }
}
