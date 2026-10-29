import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { logRoot, productionDataRoot } from "@aes/management";
import { prisma } from "../../infrastructure/prisma/client.js";
import { config } from "../../config/index.js";
import { executionAdmissionSnapshot, managedContainerSnapshot } from "../../modules/execution/index.js";

const exec = promisify(execFile);
const windowMs = 300_000;
let previousCpu: { total: number; idle: number } | undefined;
let cached: Awaited<ReturnType<typeof collect>> | undefined;
let pending: Promise<Awaited<ReturnType<typeof collect>>> | undefined;
let cachedAt = 0;

async function collect() {
  const now = Date.now();
  const warnings: string[] = [];
  const cpu = os.cpus().reduce((a,c) => ({idle:a.idle+c.times.idle,total:a.total+Object.values(c.times).reduce((s,v)=>s+v,0)}),{idle:0,total:0});
  if (!previousCpu) {
    previousCpu = cpu;
    await new Promise(resolve => setTimeout(resolve, 150));
    return collect();
  }
  const delta = cpu.total - previousCpu.total;
  const cpuPercent = delta > 0 ? Math.max(0, Math.min(100,100*(1-(cpu.idle-previousCpu.idle)/delta))) : null;
  previousCpu = cpu;
  const mem = await fs.readFile("/proc/meminfo","utf8");
  const memory = (key:string) => Number(new RegExp(`^${key}:\\s+(\\d+)`,"m").exec(mem)?.[1] ?? 0)*1024;
  const disk = await fs.statfs(productionDataRoot());
  const activity = new Map<string,{lastSeen:number;modules:Set<string>}>();
  let homeworksIds: Record<string,string> = {};
  try {
    const code = "import sqlite3,json,sys\nc=sqlite3.connect('file:'+sys.argv[1]+'?mode=ro',uri=True)\nprint(json.dumps({str(r[0]):r[1] for r in c.execute('SELECT id,external_id FROM users WHERE external_id IS NOT NULL')}))";
    homeworksIds = JSON.parse((await exec("python3",["-c",code,config.HOMEWORKS_ACCOUNT_DATABASE_PATH],{timeout:3000,maxBuffer:4*1024*1024})).stdout);
  } catch { warnings.push("Homeworks 用户关联暂不可用"); }
  try {
    const dir = path.join(logRoot(),"operations");
    const files = await fs.readdir(dir);
    const recent = (await Promise.all(files.filter(n=>/^(courseworks|homeworks|slideshow)-\d+\.jsonl(?:\.\d+)?$/.test(n)).map(async name=>({name,stat:await fs.stat(path.join(dir,name))})))).filter(f=>f.stat.mtimeMs>now-windowMs).sort((a,b)=>b.stat.mtimeMs-a.stat.mtimeMs);
    if(recent.length>32) warnings.push("活动日志繁忙，仅展示最近部分记录");
    for(const item of recent.slice(0,32)) {
      const file=await fs.open(path.join(dir,item.name),"r");
      let text="";
      try {
        const size=(await file.stat()).size;
        const length=Math.min(size,1024*1024);
        const buffer=Buffer.alloc(length);
        const read=await file.read(buffer,0,length,size-length);
        text=buffer.subarray(0,read.bytesRead).toString("utf8");
        if(size>length){text=text.slice(text.indexOf("\n")+1);warnings.push("部分活动日志已截断，活跃人数可能偏低");}
      } finally {await file.close();}
      for(const line of text.split("\n")) {
        let e; try{e=JSON.parse(line);}catch{continue;}
        const time=Date.parse(e.time);
        if(!e.userId || !Number.isFinite(time)||time<now-windowMs||time>now+1000||e.status>=400)continue;
        const id=e.service==="homeworks"?homeworksIds[String(e.userId)]:String(e.userId);
        if(!id)continue;
        const module=e.service==="courseworks" ? (e.module==="workspace"?(String(e.route).includes("lab")?"Courseworks / OS Lab":"Courseworks / 工作区"):e.module==="agent"?"Courseworks / Agent":e.module==="admin"?"系统管理":"服务门户") : e.service==="homeworks"?"Homeworks":"Slideshow";
        const current=activity.get(id)??{lastSeen:0,modules:new Set<string>()};
        current.lastSeen=Math.max(current.lastSeen,time);current.modules.add(module);activity.set(id,current);
      }
    }
  } catch {warnings.push("活动日志暂不可用");}
  const containers=managedContainerSnapshot();
  const runs=await prisma.agentRun.findMany({where:{finishedAt:null},select:{id:true,workspaceId:true,status:true}});
  const workspaces=await prisma.workspace.findMany({where:{id:{in:[...new Set([...containers.map(c=>c.workspaceId).filter((id):id is string=>!!id),...runs.map(r=>r.workspaceId)])]}},select:{id:true,userId:true}});
  for(const workspace of workspaces) if(!activity.has(workspace.userId))activity.set(workspace.userId,{lastSeen:0,modules:new Set()});
  const users=await prisma.user.findMany({where:{id:{in:[...activity.keys()]}},select:{id:true,name:true,email:true,role:true}});
  const admission=executionAdmissionSnapshot();
  return {sampledAt:new Date().toISOString(),windowSeconds:windowMs/1000,warnings:[...new Set(warnings)],
    host:{hostname:os.hostname(),cpuCores:os.cpus().length,cpuPercent,totalMemoryBytes:memory("MemTotal"),availableMemoryBytes:memory("MemAvailable"),swapUsedBytes:memory("SwapTotal")-memory("SwapFree"),loadAverage:os.loadavg(),diskTotalBytes:disk.blocks*disk.bsize,diskAvailableBytes:disk.bavail*disk.bsize,uptimeSeconds:os.uptime()},
    budget:{...admission,remainingCpu:Math.max(0,admission.cpuBudget-admission.reservedCpu),remainingMemoryBytes:Math.max(0,admission.memoryBudgetBytes-admission.reservedMemoryBytes),qemuBudget:config.EXECUTION_MAX_QEMU,containers:containers.length},
    users:users.map(user=>{const a=activity.get(user.id)!;const ids=new Set(workspaces.filter(w=>w.userId===user.id).map(w=>w.id));const owned=containers.filter(c=>c.workspaceId&&ids.has(c.workspaceId));const activeRuns=runs.filter(r=>ids.has(r.workspaceId));return {...user,lastSeen:a.lastSeen?new Date(a.lastSeen).toISOString():null,modules:[...a.modules],containers:owned,agentRuns:activeRuns};}).sort((a,b)=>(b.lastSeen??"").localeCompare(a.lastSeen??""))};
}

export async function systemMonitorSnapshot() {
  if(cached && Date.now()-cachedAt<5000)return cached;
  if(!pending)pending=collect().then(result=>{cached=result;cachedAt=Date.now();return result;}).finally(()=>{pending=undefined;});
  return pending;
}
