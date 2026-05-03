// Copyright (c) 2024-2026 James Brooks (Erosmancer). All rights reserved.
// Bridge OS — Proprietary Software. See LICENSE for terms.
// rheon.world · github.com/HorrisEllis/Bridge-v2
'use strict';
/**
 * bridge-gateway/index.js  v1.0.0
 * HTTP API gateway — port 3748.
 * Proxies :3747. Rate limiting, CORS, request logging, /gateway/status.
 * init(busShim) matches the boot.js optional module pattern.
 */
const http=require('http'),crypto=require('crypto');
const MODULE_UUID='bridge-gateway-0001-0000-000000000001',MODULE_VERSION='1.0.0';
const GATEWAY_PORT=Number(process.env.NEXUS_GATEWAY_PORT)||3748;
const UPSTREAM_PORT=Number(process.env.NEXUS_PORT)||3747;
const UPSTREAM_HOST='127.0.0.1';
function createRateLimiter(max=200,wMs=60000){
  const w=new Map();
  setInterval(()=>{const n=Date.now();for(const[k,v]of w)if(n>v.r)w.delete(k);},wMs).unref();
  return ip=>{const n=Date.now();const e=w.get(ip)||{c:0,r:n+wMs};e.c++;w.set(ip,e);return e.c<=max;};
}
let _server=null,_bus=null,_init=false;
const _stats={requests:0,blocked:0,errors:0,since:Date.now()};
const rl=createRateLimiter();
function _proxy(req,res,body,rid){
  const opts={hostname:UPSTREAM_HOST,port:UPSTREAM_PORT,path:req.url,method:req.method,
    headers:{...req.headers,host:`${UPSTREAM_HOST}:${UPSTREAM_PORT}`,'x-request-id':rid,'x-gateway':MODULE_VERSION}};
  delete opts.headers['content-length'];if(body.length)opts.headers['content-length']=body.length;
  const p=http.request(opts,up=>{res.writeHead(up.statusCode,{...up.headers,'access-control-allow-origin':'*','x-request-id':rid});up.pipe(res);});
  p.on('error',e=>{_stats.errors++;if(!res.headersSent){res.writeHead(502,{'Content-Type':'application/json'});res.end(JSON.stringify({ok:false,error:'upstream unavailable',detail:e.message}));}});
  if(body.length)p.write(body);p.end();
}
function init(busShim){
  if(_init)return;_init=true;_bus=busShim;
  _server=http.createServer(async(req,res)=>{
    _stats.requests++;const rid=crypto.randomBytes(6).toString('hex');const ip=req.socket?.remoteAddress||'?';
    if(req.method==='OPTIONS'){res.writeHead(204,{'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'GET,POST,PUT,DELETE,OPTIONS','Access-Control-Allow-Headers':'Content-Type,Authorization,X-Api-Key,X-Gateway','Access-Control-Max-Age':'86400'});return res.end();}
    if(!rl(ip)){_stats.blocked++;res.writeHead(429,{'Content-Type':'application/json'});return res.end(JSON.stringify({ok:false,error:'rate limit exceeded'}));}
    const parts=(req.url||'/').split('?')[0].split('/').filter(Boolean);
    if(req.method==='GET'&&parts[0]==='gateway'&&parts[1]==='status'){res.writeHead(200,{'Content-Type':'application/json'});return res.end(JSON.stringify({ok:true,uuid:MODULE_UUID,version:MODULE_VERSION,port:GATEWAY_PORT,upstream:`http://${UPSTREAM_HOST}:${UPSTREAM_PORT}`,stats:{..._stats,uptimeSec:Math.round((Date.now()-_stats.since)/1000)}}));}
    const chunks=[];for await(const c of req)chunks.push(c);const body=Buffer.concat(chunks);
    _bus?.emit?.('gateway:request',{rid,method:req.method,url:req.url,ip,size:body.length},'DEBUG');
    _proxy(req,res,body,rid);
  });
  _server.listen(GATEWAY_PORT,'0.0.0.0',()=>_bus?.emit?.('gateway:online',{port:GATEWAY_PORT,upstream:UPSTREAM_PORT},'INFO'));
  _server.on('error',e=>{_stats.errors++;_bus?.emit?.('gateway:error',{error:e.message},'WARN');});
}
function stop(){_server?.close();_init=false;}
function diagnostics(){return{uuid:MODULE_UUID,version:MODULE_VERSION,port:GATEWAY_PORT,stats:{..._stats}};}
module.exports={init,stop,diagnostics,MODULE_UUID,MODULE_VERSION};
