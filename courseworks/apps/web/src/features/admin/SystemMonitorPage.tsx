import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { apiFetch } from "../../shared/api/client";
import { useAuth } from "../auth/auth-context";
import { Icon } from "../workspace/workspace-icons";
import "./system-monitor.css";

type Snapshot = {
  sampledAt:string;windowSeconds:number;warnings:string[];
  host:{hostname:string;cpuCores:number;cpuPercent:number|null;totalMemoryBytes:number;availableMemoryBytes:number;swapUsedBytes:number;loadAverage:number[];diskTotalBytes:number;diskAvailableBytes:number;uptimeSeconds:number};
  budget:{active:number;waiting:number;reservedCpu:number;reservedMemoryBytes:number;cpuBudget:number;memoryBudgetBytes:number;remainingCpu:number;remainingMemoryBytes:number;qemu:number;qemuBudget:number;containers:number};
  users:{id:string;name:string|null;email:string;role:string;lastSeen:string|null;modules:string[];containers:{purpose:string;cpuLimit:number;memoryLimitBytes:number}[];agentRuns:{id:string;status:string}[]}[];
};
const gib=(n:number)=>(n/1024**3).toFixed(2)+" GiB";
const number=(n:number)=>Number(n.toFixed(2));
const roles:Record<string,string>={super_admin:"超级管理员",teacher:"教师",student:"学生",ta:"助教"};
const purposes:Record<string,string>={shell:"OS Lab 终端",sidecar:"辅助容器",qemu:"QEMU",tool:"工具执行",build:"编译"};
function recentActivity(lastSeen:string|null,sampledAt:string){
  if(!lastSeen)return "近期无页面请求";
  const minutes=Math.floor(Math.max(0,Date.parse(sampledAt)-Date.parse(lastSeen))/60000);
  return minutes<1?"刚刚活跃（1 分钟内）":`${minutes} 分钟前活跃`;
}
function Meter({value,max}:{value:number;max:number}){return <progress value={value} max={max||1} aria-label="资源占用"/>;}
export function SystemMonitorPage(){
  const {token}=useAuth();
  const [data,setData]=useState<Snapshot|null>(null);
  const [error,setError]=useState("");
  const [filter,setFilter]=useState("");
  const [refresh,setRefresh]=useState(0);
  useEffect(()=>{
    let stopped=false;let timer:ReturnType<typeof setTimeout>;
    async function load(){
      try{const next=await apiFetch<Snapshot>("/admin/monitor",{token});if(!stopped){setData(next);setError("");}}
      catch(e){if(!stopped)setError(e instanceof Error?e.message:"监控数据读取失败");}
      finally{if(!stopped)timer=setTimeout(load,5000);}
    }
    void load();return()=>{stopped=true;clearTimeout(timer);};
  },[token,refresh]);
  const users=data?.users.filter(u=>[u.name,u.email,roles[u.role],...u.modules].join(" ").toLowerCase().includes(filter.toLowerCase()))??[];
  return <main className="system-monitor">
    <header className="monitor-heading"><div><Link to="/portal">服务门户</Link><h1>系统监控</h1><p>{data?.host.hostname??"XPS15"} · {error?"连接异常":data?"运行状态":"正在连接"}</p></div><div className="monitor-toolbar"><span>{data?new Date(data.sampledAt).toLocaleTimeString():"等待采样"}</span><button className="secondary" title="刷新" aria-label="刷新" onClick={()=>setRefresh(v=>v+1)}><Icon name="refresh"/></button></div></header>
    {error&&<p role="alert" className="monitor-error">{error}。{data?"当前显示上次成功采样的数据。":""}</p>}
    {!data&&!error&&<p role="status">正在读取资源和用户活动…</p>}
    {data&&<>
      {data.warnings.map(w=><p className="monitor-error" key={w}>{w}</p>)}
      <section className="monitor-section monitor-users-section" aria-label="近期活跃用户"><div className="monitor-section-heading"><h2>近期活跃用户 <span>{data.users.length} 人</span></h2><input aria-label="搜索用户或模块" placeholder="搜索用户、角色或模块" value={filter} onChange={e=>setFilter(e.target.value)}/></div><p>最近 {data.windowSeconds/60} 分钟有成功请求或有后台任务的用户。近期活动不等同于持续在线。受管容器 {data.budget.containers} · 排队请求 {data.budget.waiting}</p><div className="monitor-table-scroll"><table><thead><tr><th>用户</th><th>角色</th><th>近期使用模块</th><th>当前运行任务</th><th>最近活动</th></tr></thead><tbody>
        {users.map(u=><tr key={u.id}><td><b>{u.name||"未命名"}</b><small>{u.email}</small></td><td>{roles[u.role]??u.role}</td><td>{u.modules.map(m=><span className="monitor-tag" key={m}>{m}</span>)}</td><td>{u.agentRuns.length>0&&<span className="monitor-tag running">Agent × {u.agentRuns.length}</span>}{u.containers.map((c,i)=><span className="monitor-tag running" key={i}>{purposes[c.purpose]??c.purpose}</span>)}{!u.agentRuns.length&&!u.containers.length&&<span className="monitor-muted">无后台任务</span>}</td><td>{recentActivity(u.lastSeen,data.sampledAt)}{u.lastSeen&&<small>{new Date(u.lastSeen).toLocaleTimeString()}</small>}</td></tr>)}
        {!users.length&&<tr><td colSpan={5} className="monitor-empty">{filter?"没有匹配的用户":"暂无近期用户活动或运行任务"}</td></tr>}
      </tbody></table></div></section>
      <section aria-labelledby="monitor-host-heading" className="monitor-section monitor-host-section">
        <h2 id="monitor-host-heading">主机资源状况</h2>
        <div className="monitor-metrics">
        <article><span>CPU 利用率</span><strong>{data.host.cpuPercent===null?"—":data.host.cpuPercent.toFixed(1)+"%"}</strong><Meter value={data.host.cpuPercent??0} max={100}/><small>{data.host.cpuCores} 个逻辑核心 · 负载 {data.host.loadAverage.map(n=>n.toFixed(2)).join(" / ")}</small></article>
        <article><span>内存使用率</span><strong>{((1-data.host.availableMemoryBytes/data.host.totalMemoryBytes)*100).toFixed(1)}%</strong><Meter value={data.host.totalMemoryBytes-data.host.availableMemoryBytes} max={data.host.totalMemoryBytes}/><small>可用 {gib(data.host.availableMemoryBytes)} / 总计 {gib(data.host.totalMemoryBytes)}</small></article>
        <article><span>数据盘可用空间</span><strong>{gib(data.host.diskAvailableBytes)}</strong><Meter value={data.host.diskTotalBytes-data.host.diskAvailableBytes} max={data.host.diskTotalBytes}/><small>总计 {gib(data.host.diskTotalBytes)} · Swap 已用 {gib(data.host.swapUsedBytes)}</small></article>
        </div>
      </section>
      <section className="monitor-section"><h2>Courseworks 资源预算</h2><p>预算分配代表任务占用的配额；主机利用率反映实际消耗。</p><div className="monitor-table-scroll"><table><thead><tr><th>资源</th><th>总预算</th><th>已分配</th><th>剩余</th><th>分配比例</th></tr></thead><tbody>
        <tr><th>CPU 核心</th><td>{number(data.budget.cpuBudget)}</td><td>{number(data.budget.reservedCpu)}</td><td>{number(data.budget.remainingCpu)}</td><td><Meter value={data.budget.reservedCpu} max={data.budget.cpuBudget}/></td></tr>
        <tr><th>内存</th><td>{gib(data.budget.memoryBudgetBytes)}</td><td>{gib(data.budget.reservedMemoryBytes)}</td><td>{gib(data.budget.remainingMemoryBytes)}</td><td><Meter value={data.budget.reservedMemoryBytes} max={data.budget.memoryBudgetBytes}/></td></tr>
        <tr><th>QEMU 并发</th><td>{data.budget.qemuBudget}</td><td>{data.budget.qemu}</td><td>{Math.max(0,data.budget.qemuBudget-data.budget.qemu)}</td><td><Meter value={data.budget.qemu} max={data.budget.qemuBudget}/></td></tr>
      </tbody></table></div></section>
    </>}
  </main>;
}
