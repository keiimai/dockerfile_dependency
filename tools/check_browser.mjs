import assert from "node:assert/strict";
import http from "node:http";
import {spawn} from "node:child_process";
import {mkdir,readFile} from "node:fs/promises";
import {setTimeout as delay} from "node:timers/promises";
import {resolve} from "node:path";

const root = resolve("dist"), profile = resolve("_tmp/browser-profile");
await mkdir(profile,{recursive:true});
const server = http.createServer(async (req,res) => {
  const path = new URL(req.url,"http://localhost").pathname;
  try {
    const bytes = await readFile(root + (path === "/" ? "/index.html" : path));
    const type = path.endsWith(".mjs") || path.endsWith(".js") ? "application/javascript" :
      path.endsWith(".gz") ? "application/gzip" : path.endsWith(".css") ? "text/css" : "text/html";
    res.writeHead(200,{"Content-Type":type}).end(bytes);
  } catch { res.writeHead(404).end(); }
});
await new Promise(ok => server.listen(0,"127.0.0.1",ok));
const browser = spawn("google-chrome",["--headless","--disable-gpu","--no-sandbox","--remote-debugging-port=0",
  "--user-data-dir=" + profile,"about:blank"],{stdio:"ignore"});
async function until(fn,timeout=18000) {
  const end = Date.now()+timeout;
  let error;
  while (Date.now()<end) { try { const result = await fn(); if (result) return result; } catch (e) { error=e; } await delay(80); }
  throw new Error("Browser expectation timed out: " + (error?.message ?? fn));
}
try {
  const port = await until(async () => (await readFile(profile+"/DevToolsActivePort","utf8")).split("\n")[0]);
  const tabs = await (await fetch("http://localhost:"+port+"/json/list")).json();
  const ws = new WebSocket(tabs.find(t=>t.type==="page").webSocketDebuggerUrl);
  await new Promise(ok=>ws.addEventListener("open",ok,{once:true}));
  let seq = 0; const pending = new Map();
  ws.onmessage = event => { const m=JSON.parse(event.data); if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
  const call=async (method,params={})=>{
    const id=++seq; const wait=new Promise(ok=>pending.set(id,ok)); ws.send(JSON.stringify({id,method,params}));
    const m=await wait; if (m.error) throw Error(m.error.message); return m.result;
  };
  const evaluate=async(expression)=>{
    const result=await call("Runtime.evaluate",{expression,returnByValue:true,awaitPromise:true});
    if (result.exceptionDetails) throw Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result.value;
  };
  await call("Page.addScriptToEvaluateOnNewDocument",{source:`
    window.counts={r:0,apt:0}; const nativeFetch=window.fetch.bind(window);
    window.fetch=async(u,options)=>{
      if (String(u).includes("ubuntu-noble-arm64.json.gz") && ++counts.apt === 1) {
        return new Promise((_,reject)=>options.signal.addEventListener("abort",()=>reject(options.signal.reason),{once:true}));
      }
      if (String(u).includes("cran.r-universe.dev/api/packages/")) {
        counts.r++;return Response.json({Package:"Demo",Version:"1.0",_type:"src",_file:"Demo_1.0.tar.gz",
          _sha256:"b".repeat(64),_dependencies:[],SystemRequirements:"GDAL"});
      }
      return nativeFetch(u,options);
    };
    window.el=(id)=>document.getElementById(id);
    window.enter=(id,val)=>{el(id).value=val;el(id).dispatchEvent(new Event('input',{bubbles:true}));};
    window.choose=(id,val)=>{el(id).value=val;el(id).dispatchEvent(new Event('change',{bubbles:true}));};`});
  await call("Page.navigate",{url:"http://127.0.0.1:"+server.address().port});
  await until(()=>evaluate("el('r-version')?.options.length > 1"));
  await evaluate("choose('r-version','custom'); enter('custom-version','4.5.0');enter('packages','Demo');el('submit').click()");
  await until(()=>evaluate("el('input-error').textContent.includes('4.5.1')"));
  await evaluate("choose('language','python'); choose('r-version','custom'); enter('custom-version','3.9');enter('packages','Demo');el('submit').click()");
  assert(await evaluate("el('input-error').textContent.includes('3.10')"));
  await evaluate("choose('language','r');choose('r-version','4.6.1');enter('packages','Demo');el('submit').click()");
  await until(()=>evaluate("!el('active').hidden && el('verification-scope').textContent.includes('1 件')"));
  assert(await evaluate("!el('packages').disabled && el('download-dockerfile').disabled && counts.r===1"));
  await until(()=>evaluate("!el('apt-retry').hidden"));
  assert(await evaluate("el('results').textContent.includes('タイムアウト') && el('download-dockerfile').disabled"));
  await evaluate("el('apt-retry').click()");
  await until(()=>evaluate("!el('download-dockerfile').disabled"));
  assert(await evaluate("counts.r===1 && counts.apt===2 && el('docker-code').textContent.includes('libgdal-dev=')"));
  ws.close();
  console.log("Chromium: supported versions, partial report, timeout, isolated APT retry and recovered Dockerfile verified.");
} finally { browser.kill(); server.close(); }
