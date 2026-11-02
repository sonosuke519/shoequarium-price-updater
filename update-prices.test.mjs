import test from 'node:test';
import assert from 'node:assert/strict';
import { updatePrices, latestScheduledSlot } from './scripts/update-prices.mjs';

const key='a'.repeat(64),providers=['rakuten','yahoo'];
const progress=(provider,completed=3,extra={})=>({provider,jobId:provider+'-job',completed,total:3,failed:0,status:completed===3?'completed':'running',done:completed===3,...extra});
function status(){return {models:3,providers:Object.fromEntries(providers.map(p=>[p,{current:3,oldestCheckedAt:new Date().toISOString(),job:{id:p+'-job',modelCount:3,completed:3,failed:0,status:'completed'}}])),catalog:{displayableModels:2,pricedModels:2}};}
const json=(value,status=200)=>Response.json(value,{status});

test('resumes serial batches independently, retries an outage and lease conflict, then verifies persisted state',async()=>{
 const calls={rakuten:0,yahoo:0},logs=[],waits=[];let active=new Set();
 const result=await updatePrices({key,delay:async ms=>waits.push(ms),log:r=>logs.push(r),fetcher:async(url,init)=>{
  assert.equal(String(url),'https://oysteryakiniku.com/api/retail/automation');assert.equal(init.redirect,'error');assert.equal(init.headers.authorization,'Bearer '+key);
  if(!init.body)return json(status());
  const {provider,maxModels}=JSON.parse(init.body);assert.equal(maxModels,10);assert.equal(active.has(provider),false);active.add(provider);await Promise.resolve();active.delete(provider);
  const call=++calls[provider];
  if(provider==='rakuten'&&call===1)return json({},503);
  if(provider==='yahoo'&&call===1)return json({busy:true,done:false},409);
  return json(progress(provider,call===2?1:3));
 }});
 assert.equal(result.models,3);assert.deepEqual(calls,{rakuten:3,yahoo:3});assert.ok(waits.includes(5000));assert.ok(waits.includes(10000));assert.equal(logs.at(-1).verified,true);assert.equal(JSON.stringify(logs).includes(key),false);
});

test('does not accept a done flag with missing models or incomplete persisted data',async()=>{
 await assert.rejects(()=>updatePrices({key,delay:async()=>{},log:()=>{},fetcher:async(_,init)=>init.body?json(progress(JSON.parse(init.body).provider,2,{done:true,status:'completed'})):json(status())}),/incomplete_update/);
 const stale=status();stale.providers.rakuten.current=2;
 await assert.rejects(()=>updatePrices({key,delay:async()=>{},log:()=>{},fetcher:async(_,init)=>init.body?json(progress(JSON.parse(init.body).provider)):json(stale)}),/verification_failed/);
});

test('retries partial failures once while preserving the independent provider result',async()=>{
 const calls={rakuten:0,yahoo:0};
 await updatePrices({key,delay:async()=>{},log:()=>{},fetcher:async(_,init)=>{
  if(!init.body)return json(status());const p=JSON.parse(init.body).provider;calls[p]++;
  return json(progress(p,3,p==='rakuten'&&calls[p]===1?{status:'completed_with_errors',failed:1}:{}));
 }});
 assert.deepEqual(calls,{rakuten:2,yahoo:1});
});

test('authentication failures are not retried or exposed as response bodies',async()=>{
 let calls=0;const logs=[];
 await assert.rejects(()=>updatePrices({key,log:r=>logs.push(r),fetcher:async()=>{calls++;return new Response(key,{status:401});}}),/site_authentication_failed/);
 assert.equal(calls,3);assert.equal(JSON.stringify(logs).includes(key),false);
});

test('stops within the deadline when another worker continuously holds the lease',async()=>{
 let clock=0;
 await assert.rejects(()=>updatePrices({key,now:()=>clock,maxDurationMs:1000,delay:async ms=>{clock+=ms;},log:()=>{},fetcher:async(_,init)=>init.body?json({busy:true},409):json(status())}),/deadline_exceeded/);
});

test('the backup checks completion without issuing another price-update request',async()=>{
 const previous=status(),since=Date.now()-60_000;for(const p of providers)previous.providers[p].job.finishedAt=new Date().toISOString();
 let calls=0;
 await updatePrices({key,completedSince:since,log:()=>{},fetcher:async(_,init)=>{calls++;assert.equal(init.method,'GET');return json(previous);}});
 assert.equal(calls,1);
 const stale=status();for(const p of providers)stale.providers[p].job.finishedAt=new Date(since-60_000).toISOString();
 let posts=0;
 await updatePrices({key,completedSince:since,log:()=>{},fetcher:async(_,init)=>{if(init.body){posts++;return json(progress(JSON.parse(init.body).provider));}return json(stale);}});
 assert.equal(posts,2);
});

test('verification-only mode never updates incomplete saved results',async()=>{
 const partial=status();partial.providers.yahoo.current=2;
 await assert.rejects(()=>updatePrices({key,verifyOnly:true,log:()=>{},fetcher:async(_,init)=>{assert.equal(init.method,'GET');return json(partial);}}),/verification_failed/);
});

test('Japan 03:00 and 15:00 slots handle the UTC day boundary and delayed starts',()=>{
 assert.equal(new Date(latestScheduledSlot(Date.parse('2026-11-02T05:59:00Z'))).toISOString(),'2026-11-01T18:00:00.000Z');
 assert.equal(new Date(latestScheduledSlot(Date.parse('2026-11-02T06:30:00Z'))).toISOString(),'2026-11-02T06:00:00.000Z');
 assert.equal(new Date(latestScheduledSlot(Date.parse('2026-11-02T18:30:00Z'))).toISOString(),'2026-11-02T18:00:00.000Z');
});
