// Copyright (c) 2024-2026 James Brooks (Erosmancer). All rights reserved.
// Bridge OS — Proprietary Software. See LICENSE for terms.
// rheon.world · github.com/HorrisEllis/Bridge-v2
'use strict';
/**
 * bridge-node/boot.js  v1.2.0
 * Sovereign Node — pretty boot banner, inbound node notifications, module registry.
 */

const path = require('path');
const fs   = require('fs');
const http = require('http');

const { loadOrInit }             = require('../bridge-identity/index');
const { createBus }              = require('../bridge-core/bus');
const { createCalltoRegistry, createNodeRegistry } = require('../bridge-core/registry/index');
const { createIME }              = require('../bridge-IME/index');
const { createSNGate }           = require('../bridge-sngate/index');
const { createDataBus }          = require('../bridge-data/index');
const { createHeartbeatManager } = require('../bridge-heartbeat/index');
const { createWSGateway }        = require('../bridge-plugin/gateway/ws-gateway');
const { createCalltoRouter }     = require('./callto-router');
const { createErosShim }         = require('./eros-shim');
const { createMeshNode }         = require('../bridge-mesh/index');
const { createTrustMesh }        = require('../bridge-mesh/mesh/trust-mesh');
const { createCausalAuthority }  = require('../bridge-causal/index');
const { validate }               = require('../bridge-contracts/index');
const { AppIDRegistry }          = require('../bridge-appid/index');
const { createDHT }              = require('../bridge-dht/index');
const { createModuleRegistry }   = require('./module-registry');
const { createNetworkIdentity }  = require('./network-identity');

function tryRequire(p) { try { return require(p); } catch { return null; } }
const Routing  = tryRequire('../bridge-routing/index');
const Gateway  = tryRequire('../bridge-gateway/index');
const Canvas   = tryRequire('../bridge-canvas/index');
const Magnet   = tryRequire('../bridge-magnet/index');
const Bayesian = tryRequire('../bridge-bayesian/index');
const Ollama   = tryRequire('../bridge-ollama/index');

const VERSION = '1.2.0';

// Port registry — auto-detect free port in the Bridge OS port plan
const { findFreePort, PORT_PLAN } = require('../bridge-mesh/network/port-registry');

const DEFAULT_CFG = {
  port:              Number(process.env.NEXUS_PORT)    || 0, // 0 = auto-detect
  bindHost:          process.env.NEXUS_BIND_HOST       || '0.0.0.0',
  dataDir:           process.env.NEXUS_DATA_DIR        || path.join(process.cwd(), 'data'),
  groupHint:         process.env.NEXUS_GROUP           || null,
  playwrightEnabled: process.env.NEXUS_PLAYWRIGHT      === 'true',
  logLevel:          process.env.NEXUS_LOG             || 'INFO',
  announcedHost:     process.env.NEXUS_ANNOUNCED_HOST  || null,
  dhtBootstrap:      (process.env.NEXUS_DHT_BOOTSTRAP||'').split(',').filter(Boolean),
};

// ── Pretty console ────────────────────────────────────────────────────────────
const R='\x1b[0m',B='\x1b[1m',DIM='\x1b[2m',CY='\x1b[96m',GR='\x1b[92m',YL='\x1b[93m',RD='\x1b[91m';

function printBanner(v) {
  const L='─'.repeat(52);
  console.log(`\n  ${B}${CY}╔${L}╗${R}`);
  console.log(`  ${B}${CY}║${R}  ${B}BRIDGE OS  Sovereign Node  v${v}${R}${' '.repeat(52-28-v.length)}${B}${CY}║${R}`);
  console.log(`  ${B}${CY}║${R}  ${DIM}SISO · Causal · Trust · Mesh · DHT${R}                  ${B}${CY}║${R}`);
  console.log(`  ${B}${CY}╚${L}╝${R}\n`);
}

function printPhase(num, name, status, detail='') {
  const icon={ok:`${GR}✓${R}`,warn:`${YL}⚠${R}`,skip:`${DIM}·${R}`,fail:`${RD}✗${R}`}[status]||`${DIM}·${R}`;
  const det=detail?`  ${DIM}${detail}${R}`:'';
  console.log(`  ${icon}  Phase ${String(num).padStart(3)}  ${name.padEnd(16)}${det}`);
}

function printOnline(uuid, port, elapsed, bindHost, announcedHost) {
  console.log('');
  console.log(`  ${GR}●${R}  Online in ${B}${elapsed}s${R}`);
  console.log(`  ${DIM}│${R}  UUID     ${uuid}`);
  console.log(`  ${DIM}│${R}  ShortID  ${B}${uuid.slice(0,8)}${R}`);
  console.log(`  ${DIM}│${R}  Bind     ${bindHost==='0.0.0.0'?'0.0.0.0 (all)':bindHost}:${port}`);
  if(announcedHost) console.log(`  ${DIM}│${R}  Announce http://${announcedHost}:${port}`);
  console.log(`  ${DIM}│${R}  Local    http://localhost:${port}`);
  console.log(`  ${DIM}│${R}  CLI      node index.js --cli`);
  console.log(`  ${DIM}└${R}  nexus://${uuid.slice(0,8)}\n`);
}

function jsonRes(res,status,body) {
  if(res.headersSent)return;
  const d=JSON.stringify(body,null,2);
  res.writeHead(status,{'Content-Type':'application/json','Access-Control-Allow-Origin':'*','Content-Length':Buffer.byteLength(d)});
  res.end(d);
}

function checkAuth(req,res) {
  const k=process.env.NEXUS_API_KEY; if(!k)return true;
  const p=req.headers['authorization']?.replace('Bearer ','')||req.headers['x-api-key'];
  if(p!==k){jsonRes(res,401,{ok:false,error:'Unauthorized'});return false;} return true;
}

async function boot(cfg={}) {
  const config={...DEFAULT_CFG,...cfg};
  const t0=Date.now();
  printBanner(VERSION);

  // ── Port auto-detection ─────────────────────────────────────────────────
  // If NEXUS_PORT is not set (or 0), find the first free port in the
  // Bridge OS port plan: 3747 → 3748 → 3749 → 3750 → dynamic 10000-65535.
  // This prevents the "port already in use" crash when multiple instances
  // or another process holds 3747.
  if (!config.port || config.port === 0) {
    try {
      config.port = await findFreePort(PORT_PLAN.bridge);
      console.log(`\x1b[96m  [port-registry] Auto-selected port ${config.port}\x1b[0m`);
    } catch(e) {
      console.error('[port-registry] Failed to find free port:', e.message);
      config.port = 3747; // last-resort fallback
    }
  } else {
    // Explicit port requested — check it's actually free
    const { isPortFree } = require('../bridge-mesh/network/port-registry');
    const free = await isPortFree(config.port).catch(() => false);
    if (!free) {
      console.warn(`\x1b[93m  [port-registry] Port ${config.port} busy — finding next free port\x1b[0m`);
      config.port = await findFreePort(PORT_PLAN.bridge).catch(() => config.port + 1);
      console.log(`\x1b[96m  [port-registry] Using port ${config.port}\x1b[0m`);
    }
  }

  // Discover real machine addresses — LAN, VPN, public
  const netId = createNetworkIdentity({ busEmit: null, port: config.port });
  // Kick off public IP detection in background (non-blocking)
  netId.discoverPublicIP().catch(() => null);

  // Phase 1
  let identity;
  try{identity=await loadOrInit({dataDir:config.dataDir,groupHint:config.groupHint});printPhase(1,'identity','ok',identity.uuid.slice(0,8));}
  catch(e){printPhase(1,'identity','fail',e.message);throw e;}

  // Phase 2
  let _busRef=null;
  const deferredEmit=(sig,data,level)=>_busRef?.(sig,data,level);
  const calltoRegistry=createCalltoRegistry();
  const nodeRegistry=createNodeRegistry({busEmit:deferredEmit});
  const appid=new AppIDRegistry({dataDir:config.dataDir,identity:null,busEmit:null});
  printPhase(2,'core','ok','registries + SISO');

  // Phase 3
  let ime;
  try{ime=createIME({storeDir:path.join(config.dataDir,'ime'),baselineMinEvents:100});printPhase(3,'IME','ok','behavioral memory');}
  catch(e){printPhase(3,'IME','fail',e.message);throw e;}

  // Phase 4
  let gate;
  try{
    gate=createSNGate({logDir:path.join(config.dataDir,'sngate-logs'),rulesPath:path.join(config.dataDir,'sngate-rules.json')},ime);
    validate('IME-to-sngate',ime); validate('sngate-to-adapters',gate);
    printPhase(4,'sngate','ok','allow/deny/observe');
  }catch(e){printPhase(4,'sngate','fail',e.message);throw e;}

  // Phase 5
  let bus,busEmit,dataBus;
  try{
    bus=createBus({logLevel:config.logLevel,ime});
    busEmit=(sig,data,level='INFO')=>bus.emit(sig,data,level);
    _busRef=busEmit;
    ime.install({busEmit});
    appid._identity=identity; appid._busEmit=busEmit;
    dataBus=createDataBus({gate,ime,busEmit,deltaDir:path.join(config.dataDir,'delta')});
    validate('data-to-sngate',dataBus);
    printPhase(5,'bus + data','ok','SISO bus live');
    netId.setPort(config.port);
    // Now busEmit is live, wire it into netId
    Object.assign(netId, createNetworkIdentity({ busEmit, port: config.port }));
  }catch(e){printPhase(5,'bus + data','fail',e.message);throw e;}

  const moduleRegistry=createModuleRegistry({busEmit});

  // Phase 6
  let heartbeat;
  try{
    heartbeat=createHeartbeatManager({busEmit,nodeRegistry});
    validate('mesh-to-heartbeat',heartbeat);
    heartbeat.register(identity.uuid,`http://${netId.getBest()}:${config.port}/health`);
    printPhase(6,'heartbeat','ok','BPM + UDP :7777');
  }catch(e){printPhase(6,'heartbeat','fail',e.message);throw e;}

  // Phase 7
  let wsGateway,calltoRouter;
  try{
    wsGateway=createWSGateway({busEmit});
    calltoRouter=createCalltoRouter({wsSessions:wsGateway,erosClient:null,playwrightEnabled:config.playwrightEnabled,busEmit,calltoRegistry});
    printPhase(7,'plugin WS','ok','Guardian gateway');
  }catch(e){
    printPhase(7,'plugin WS','warn',e.message);
    wsGateway=wsGateway||{install:()=>{},route:()=>null,getState:()=>({})};
    calltoRouter=calltoRouter||{route:async()=>({ok:false,error:'WS unavailable'})};
  }

  // Phase 7b
  let erosShim;
  try{erosShim=createErosShim({busEmit});erosShim.startMonitor(10_000);calltoRouter.erosClient=erosShim;printPhase('7b','eros CDP','ok','CDP shim');}
  catch(e){printPhase('7b','eros CDP','warn',e.message);erosShim={startMonitor:()=>{}};}

  // Phase 7c
  let trustMesh,meshNode;
  try{
    trustMesh=createTrustMesh({busEmit});
    meshNode=createMeshNode({identity,gate,ime,busEmit});
    printPhase('7c','mesh','ok','ECDH + trust');
  }catch(e){
    printPhase('7c','mesh','warn',e.message);
    trustMesh={pulse:()=>{},getTrustScore:()=>5,snapshot:()=>null,diagnostics:()=>({}),observePeer:()=>{}};
    meshNode={route:()=>null};
  }

  // Phase 7d
  if(Magnet?.init){try{Magnet.init({emit:busEmit,on:bus.on.bind(bus)},{peers:[]});printPhase('7d','magnet','ok','nexus:// cascade');}catch(e){printPhase('7d','magnet','skip',e.message);}}

  // Bus wiring
  bus.on('node:dead',(d)=>{const u=d._uuid||d.uuid;if(u){nodeRegistry.evict?.(u,'heartbeat:dead');trustMesh.pulse(u,false,0.9,'node:dead');}});
  bus.on('node:degraded',(d)=>{const u=d._uuid||d.uuid;if(u)trustMesh.pulse(u,false,0.5,'node:degraded');});
  bus.on('node:evicted',(d)=>{const u=d._uuid||d.uuid;if(u)trustMesh.pulse(u,false,0.9,'node:evicted');});
  bus.on('mesh:peer:connected',(d)=>{const u=d._uuid||d.uuid;if(u){trustMesh.observePeer(u,identity.uuid);trustMesh.pulse(u,true,1.0,'mesh:peer:connected');}});
  bus.on('mesh:data:incoming',(d)=>{const u=d._uuid||d.uuid;if(u)trustMesh.pulse(u,true,0.3,'mesh:data:incoming');});
  bus.on('sngate:decision',(d)=>{if(d.decision==='deny'&&d.uuid)trustMesh.pulse(d.uuid,false,0.6,'sngate:deny');});
  bus.on('mesh:trust:update',(d)=>{if(d.uuid&&ime)ime.ingest({uuid:d.uuid,type:'mesh.connection',timestamp:Date.now(),payload:{trustScore:d.imeScore,p:d.p,isSybilSuspect:d.isSybilSuspect,reason:d.reason}});});

  // Phase 8
  let causal;
  try{
    causal=await createCausalAuthority({busEmit,dataDir:config.dataDir,identity});
    busEmit=causal.wrappedEmit; _busRef=busEmit;
    printPhase(8,'causal','ok','1M ring + CQL');
  }catch(e){
    printPhase(8,'causal','warn',e.message);
    causal={query:()=>({ok:false,events:[]}),classify:()=>'unknown',diagnostics:()=>({}),route:()=>null,wrappedEmit:busEmit};
  }

  // DHT
  let dht=null;
  // Use real LAN IPv4 for DHT announcement — never loopback
  // config.announcedHost (NEXUS_ANNOUNCED_HOST env) takes priority,
  // then netId.getBest() which returns first LAN (192.168.x.x / 10.x.x.x),
  // then public IP if no LAN found.
  const _dhtHost = config.announcedHost || netId.getBest();
  try{dht=createDHT({identity,busEmit,bootstrapPeers:config.dhtBootstrap,port:config.port,announcedHost:_dhtHost});dht.start();printPhase('9-dht','DHT','ok',`kademlia @ ${_dhtHost}`);}
  catch(e){printPhase('9-dht','DHT','warn',e.message);}

  // Phase 9
  let routing=null,gateway=null,canvas=null;
  const stateShim={identity,modules:{},dataDir:config.dataDir,ports:{mesh:config.port}};
  const busShim={emit:busEmit,on:bus.on.bind(bus)};

  if(Bayesian?.init){try{await Bayesian.init();moduleRegistry.register('bridge-bayesian',Bayesian);printPhase('9a','bayesian','ok','belief engine');}catch(e){printPhase('9a','bayesian','skip',e.message);}}
  if(Ollama?.start){try{Ollama.start(busShim);moduleRegistry.register('bridge-ollama',Ollama);printPhase('9b','ollama','ok','LLM driver');}catch(e){printPhase('9b','ollama','skip',e.message);}}
  if(Routing?.init){try{Routing.init(stateShim,busShim);routing=Routing;moduleRegistry.register('bridge-routing',Routing,{modulePath:'../bridge-routing/index'});printPhase('9c','routing','ok','TCP :3749');}catch(e){printPhase('9c','routing','skip',e.message);}}
  if(Gateway?.init){try{Gateway.init(busShim);gateway=Gateway;moduleRegistry.register('bridge-gateway',Gateway,{modulePath:'../bridge-gateway/index'});printPhase('9d','gateway','ok','HTTP :3748');}catch(e){printPhase('9d','gateway','skip',e.message);}}
  if(Canvas?.install){try{Canvas.install({dataDir:config.dataDir,bus:busShim});canvas=Canvas;moduleRegistry.register('bridge-canvas',Canvas,{modulePath:'../bridge-canvas/index'});printPhase('9e','canvas','ok','persistence');}catch(e){printPhase('9e','canvas','skip',e.message);}}

  let guardianHandshake=null;
  try{const{createGuardianHandshake}=require('../bridge-guardian/handshake');guardianHandshake=createGuardianHandshake({nodeRegistry,busEmit,identity,dataDir:config.dataDir});}catch{}

  // Phase 10: HTTP
  const server=http.createServer(async(req,res)=>{
    if(req.method==='OPTIONS'){res.writeHead(204,{'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'GET,POST,PUT,DELETE,OPTIONS','Access-Control-Allow-Headers':'Content-Type,Authorization,X-Api-Key,X-Guardian-Token'});return res.end();}
    if(!checkAuth(req,res))return;
    let body={};
    if(['POST','PUT'].includes(req.method)){const chunks=[];for await(const c of req)chunks.push(c);try{body=JSON.parse(Buffer.concat(chunks).toString());}catch{}}
    const urlParts=(req.url||'/').split('?')[0].split('/').filter(Boolean);
    const qs=Object.fromEntries(new URLSearchParams((req.url||'').split('?')[1]||''));
    const method=req.method,top=urlParts[0];

    if(method==='GET'&&top==='health')return jsonRes(res,200,{ok:true,uuid:identity.uuid,shortId:identity.uuid.slice(0,8),version:VERSION,uptime:process.uptime(),booted:`${((Date.now()-t0)/1000).toFixed(2)}s`,nodes:nodeRegistry.diagnostics(),causal:causal.diagnostics(),trust:trustMesh.diagnostics(),appid:appid.diagnostics(),network:netId.summary(config.port)});
    if(method==='GET'&&top==='identity')return jsonRes(res,200,{...identity.publicRecord(),endpoints:netId.toEndpoints(config.port),best:`http://${netId.getBest()}:${config.port}`});
    if(method==='GET'&&top==='runtime'&&urlParts[1]==='state')return jsonRes(res,200,{...wsGateway.getState(),causal:causal.diagnostics(),trust:trustMesh.diagnostics(),nodes:nodeRegistry.diagnostics()});
    if(top==='userscript')return wsGateway.route(method,urlParts,body,req,res);
    if(top==='mesh')return meshNode.route(method,urlParts,body,req,res);
    if(top==='data'){const isLocal=['127.0.0.1','::1'].includes(req.socket?.remoteAddress);if(isLocal&&!body.sig)body={...body,_localVerified:true};return dataBus.route(method,urlParts,body,req,res);}
    if(top==='appid'){const r=appid.route(method,urlParts,body);if(r)return jsonRes(res,r.ok===false?400:200,r);}
    if(method==='POST'&&top==='pulse'){
      const{instanceId,logicalId,capabilities}=body||{};
      if(!instanceId)return jsonRes(res,400,{ok:false,error:'instanceId required'});
      const addr=req.socket?.remoteAddress||'127.0.0.1';
      const isUUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(instanceId);
      const regUUID=isUUID?instanceId:require('crypto').createHash('sha256').update(instanceId).digest('hex').replace(/^(.{8})(.{4})(.{4})(.{4})(.{12}).*/,'$1-$2-$3-$4-$5');
      try{nodeRegistry.register({uuid:regUUID,address:addr,groupHint:logicalId||instanceId});}
      catch{nodeRegistry.seen?.(regUUID);}
      busEmit('node:pulse',{instanceId,logicalId,capabilities},'DEBUG');
      return jsonRes(res,200,{ok:true,uuid:identity.uuid,shortId:identity.uuid.slice(0,8),nexus:`nexus://${identity.uuid.slice(0,8)}`});
    }
    if(method==='GET'&&top==='nodes')return jsonRes(res,200,{ok:true,nodes:nodeRegistry.list({all:qs.all==='true'}),diagnostics:nodeRegistry.diagnostics()});
    if(top==='magnet'){if(method==='GET'&&urlParts[1]){const s=urlParts[1].slice(0,8).toLowerCase(),m=identity.uuid.slice(0,8).toLowerCase();if(s===m){const h=config.announcedHost||netId.getBest();return jsonRes(res,200,{ok:true,uuid:identity.uuid,shortId:m,address:`http://${h}:${config.port}`,nexus:`nexus://${m}@${h}:${config.port}`});}return jsonRes(res,404,{ok:false,error:'NODE_UNREACHABLE',shortId:s});}}
    if(top==='causal'){const r=causal.route(method,urlParts,body);if(r)return jsonRes(res,r.ok===false?400:200,r);}
    if(top==='trust'){if(method==='GET'&&urlParts[1]==='score'&&urlParts[2])return jsonRes(res,200,{ok:true,...trustMesh.snapshot(urlParts[2]),trustScore:trustMesh.getTrustScore(urlParts[2])});if(method==='GET'&&urlParts[1]==='stats')return jsonRes(res,200,{ok:true,...trustMesh.diagnostics()});}
    if(top==='guardian'&&guardianHandshake){const r=guardianHandshake.route(method,urlParts,body,req);if(r===null)return jsonRes(res,404,{ok:false,error:'Unknown guardian route'});return jsonRes(res,r.code||(r.ok===false?400:200),r);}
    if(method==='GET'&&top==='ime'&&urlParts[1]==='profile'){const p=ime.getProfile(urlParts[2]);return jsonRes(res,p?200:404,p?{ok:true,profile:p}:{ok:false,error:'not found'});}
    if(top==='sngate'){if(method==='GET'&&urlParts[1]==='trace')return jsonRes(res,200,{ok:true,entries:gate.trace.query({}).slice(-100)});if(method==='POST'&&urlParts[1]==='rules')return jsonRes(res,200,{ok:true,id:gate.rules.add(body)});if(method==='GET'&&urlParts[1]==='rules')return jsonRes(res,200,{ok:true,rules:gate.rules.list()});}
    if(method==='GET'&&top==='calltos')return jsonRes(res,200,{ok:true,calltos:calltoRegistry.list()});
    if(method==='POST'&&top==='callto'&&!urlParts[1]){const{action,selector,origin,params,tag}=body;if(!action)return jsonRes(res,400,{ok:false,error:'action required'});const reg=calltoRegistry.register({action,selector,origin,sessionId:null,tag});const gr=gate.evaluate({type:'callto.'+action,payload:{action,selector,origin},surface:'dev'});if(gr.decision==='deny')return jsonRes(res,403,{ok:false,error:'blocked',gateId:gr.gateId});const result=await calltoRouter.route({...reg,params:params||{}});return jsonRes(res,result.ok?200:500,result);}
    if(top==='dht'&&dht){const r=dht.route(method,urlParts,body);if(r!==null)return jsonRes(res,r.ok===false?400:200,r);}
    if(top==='module'){const r=moduleRegistry.route(method,urlParts,body,req,res);if(r!==null&&r!==undefined)return jsonRes(res,r.ok===false?400:200,r);if(r===null)return;}
    return jsonRes(res,404,{ok:false,error:`Unknown route: ${method} /${urlParts.join('/')}`});
  });

  wsGateway.install(server,bus);
  // Atomic bind with self-heal — TOCTOU race between isPortFree and listen is real.
  // If EADDRINUSE fires at OS level, find next free port and retry once.
  await new Promise((resolve,reject)=>{
    function tryBind(port){
      server.removeAllListeners('error');
      server.once('error',async(err)=>{
        if(err.code==='EADDRINUSE'){
          console.warn(`[port-registry] EADDRINUSE on ${port} — re-running findFreePort`);
          try{
            const next=await findFreePort(PORT_PLAN.bridge);
            config.port=next;
            netId.setPort(next);
            console.log(`[port-registry] Retrying on port ${next}`);
            tryBind(next);
          }catch(e2){reject(e2);}
        }else{reject(err);}
      });
      server.once('listening',resolve);
      server.listen(port,config.bindHost);
    }
    tryBind(config.port);
  });

  const elapsed=((Date.now()-t0)/1000).toFixed(2);
  printPhase(10,'HTTP server','ok',`:${config.port}`);
  // Print real machine addresses
  const _nets = netId.getAll();
  const _lan  = _nets.filter(a => a.scope === 'lan').map(a => `http://${a.ip}:${config.port}`);
  const _pub  = netId.getPublicIP() ? [`http://${netId.getPublicIP()}:${config.port}`] : [];
  printOnline(identity.uuid, config.port, elapsed, _lan.length ? _lan : [`http://${netId.getBest()}:${config.port}`], _pub);
  busEmit('bridge:boot',{_uuid:identity.uuid,uuid:identity.uuid,port:config.port,elapsed,version:VERSION},'INFO');

  return{server,identity,bus,busEmit,ime,gate,dataBus,heartbeat,wsGateway,calltoRouter,calltoRegistry,nodeRegistry,meshNode,trustMesh,causal,erosShim,dht,routing,gateway,canvas,appid,guardianHandshake,moduleRegistry,config,netId};
}

function attachShutdown(server,busEmit,uuid){
  const shutdown=(sig)=>{
    console.log(`\n  \x1b[33m⚡\x1b[0m  Shutting down (${sig})…`);
    busEmit?.('bridge:shutdown',{uuid,signal:sig},'INFO');
    try{fs.unlinkSync(path.join(__dirname,'../node.lock'));}catch{}
    server.close(()=>process.exit(0));
    setTimeout(()=>process.exit(1),5_000);
  };
  process.on('SIGTERM',()=>shutdown('SIGTERM'));
  process.on('SIGINT',()=>shutdown('SIGINT'));
}

module.exports={boot,attachShutdown};
