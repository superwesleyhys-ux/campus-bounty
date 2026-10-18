"use client";
import { useEffect, useRef, useState } from "react";
import { ApiError, request } from "./api";
export type MoneyIntent = {account:string; resource:string; path:string; body:Record<string,unknown>; key:string; expected:Record<string,unknown>; required:string[]};
function storedIntent(value:string|null,account:string,resource:string):MoneyIntent|null {
 const p=value?JSON.parse(value):null;if(p===null)return null;
 if(!p||p.account!==account||p.resource!==resource||typeof p.path!=='string'||!/^[-a-zA-Z0-9/]+$/.test(p.path)||p.path.startsWith('/')||typeof p.key!=='string'||!p.body||typeof p.body!=='object'||Array.isArray(p.body)||!p.expected||typeof p.expected!=='object'||Array.isArray(p.expected)||!Array.isArray(p.required)||!p.required.every((v:unknown)=>typeof v==='string'))throw Error('The saved request cannot be safely recovered. Keep it saved and contact support; do not start another payment.');return p;
}
export async function paymentIdentity(account:string, signal?:AbortSignal) {
  const me=await request<{id:string}>("me",{signal});
  if(me.id!==account) throw new ApiError("Your account changed. Sign in to the original account to recover this request.",403,"account_changed");
}
export function verifyMoneyReceipt(result:{receipt?:Record<string,unknown>}, intent:MoneyIntent) {
  const receipt=result.receipt;
  if(!receipt || intent.required.some(k=>receipt[k]===undefined || receipt[k]===null) || Object.entries(intent.expected).some(([k,v])=>JSON.stringify(receipt[k])!==JSON.stringify(v))) throw Error("The receipt does not match this request. Recover the same request; do not start another payment.");
}
export function usePaymentRequest(account:string,resource:string) {
  const storage=`campus:money:${account}:${resource}`;
  const [pending,setPending]=useState<MoneyIntent|null>(null),[busy,setBusy]=useState(false),[ready,setReady]=useState(false),[error,setError]=useState<Error|null>(null);
  const generation=useRef(0),controller=useRef<AbortController|null>(null),running=useRef(false);
  useEffect(()=>{
    const sync=()=>{try {const p=storedIntent(localStorage.getItem(storage),account,resource);setPending(p);setReady(true);}catch{setError(Error("Durable payment recovery storage is unavailable. Enable local storage before starting a payment."));setReady(false);}};
    const clearPrivate=()=>{generation.current++;controller.current?.abort();setError(null);setReady(false);};
    const changed=(e:StorageEvent)=>{if(e.key===storage)sync();if(e.key==="campus:auth-version")clearPrivate();};
    sync();window.addEventListener("storage",changed);window.addEventListener("campus:session-expired",clearPrivate);
    return ()=>{clearPrivate();window.removeEventListener("storage",changed);window.removeEventListener("campus:session-expired",clearPrivate);};
  },[storage,account,resource]);
  async function send(path?:string,body:Record<string,unknown>={},expected:Record<string,unknown>={},required:string[]=[]):Promise<Record<string,any>|undefined> {
    if(!ready||running.current) return;
    running.current=true;setBusy(true);setError(null);const turn=generation.current;
    const execute=async()=>{
      let p:MoneyIntent|null=null,wasPending=false,stage="identity";
      controller.current=new AbortController();
      try {
        await paymentIdentity(account,controller.current.signal);
        const saved=storedIntent(localStorage.getItem(storage),account,resource);
        if(saved){p=saved;wasPending=true;if(path)throw Error("Another request is already saved. Use Recover the same request before starting a different action.");}
        else {if(!path)return;p={account,resource,path,body:structuredClone(body),key:crypto.randomUUID(),expected:structuredClone(expected),required};}
        if(turn!==generation.current||!p)return;
        localStorage.setItem(storage,JSON.stringify(p));setPending(p);
        stage="mutation";
        const response=await fetch(`/api/v1/${p.path}`,{method:"POST",credentials:"same-origin",cache:"no-store",signal:AbortSignal.any([controller.current.signal,AbortSignal.timeout(30000)]),headers:{"Content-Type":"application/json","Idempotency-Key":p.key},body:JSON.stringify(p.body)});
        const result=await response.json();
        if(!response.ok)throw new ApiError(result.detail||"Payment request could not be confirmed.",response.status,result.code);
        stage="verification";
        const bytes=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(JSON.stringify([account,`/api/v1/${p.path}`,p.key,p.body])));
        const hash=Array.from(new Uint8Array(bytes),b=>b.toString(16).padStart(2,"0")).join("");
        if(response.headers.get("X-Campus-Mutation-Receipt")!==hash)throw Error("Receipt identity is unverified. Recover the same request.");
        verifyMoneyReceipt(result,p);await paymentIdentity(account,controller.current.signal);
        if(turn!==generation.current)return;
        localStorage.removeItem(storage);setPending(null);return result;
      }catch(cause){
        if(turn!==generation.current)return;
        const e=cause instanceof Error?cause:Error("Payment result unknown.");setError(e);
        // A recovery 4xx or failed status GET cannot prove an earlier request did not commit.
        if(!wasPending&&stage==="mutation"&&e instanceof ApiError&&e.status>=400&&e.status<500){localStorage.removeItem(storage);setPending(null);}
        if(e instanceof ApiError&&(e.status===401||e.code==="account_changed"))window.dispatchEvent(new Event("campus:session-expired"));
      }
    };
    try {if(!navigator.locks)throw Error("This browser cannot safely coordinate payment tabs. Use a browser with Web Locks support.");return await navigator.locks.request(storage,execute);}catch(e){setError(e as Error);}finally{running.current=false;if(turn===generation.current)setBusy(false);}
  }
  return {send,pending,busy,ready,error,blocked:busy||!ready||!!pending};
}
export function usePaymentRead<T>(account:string,path:string|null) {
  const [data,setData]=useState<T>(),[error,setError]=useState<Error>(),[loading,setLoading]=useState(true),[version,setVersion]=useState(0);
  const reload=()=>setVersion(v=>v+1);
  useEffect(()=>{
    const c=new AbortController();setData(undefined);setError(undefined);setLoading(true);
    const invalidate=()=>{c.abort();setData(undefined);setLoading(false);};
    const changed=(e:StorageEvent)=>{if(e.key==="campus:auth-version")invalidate();};
    window.addEventListener("storage",changed);window.addEventListener("campus:session-expired",invalidate);
    if(path)(async()=>{try{await paymentIdentity(account,c.signal);const next=await request<T>(path,{signal:c.signal});await paymentIdentity(account,c.signal);if(!c.signal.aborted){setData(next);setLoading(false);}}catch(e){if(!c.signal.aborted){setError(e as Error);setLoading(false);}}})();else setLoading(false);
    return ()=>{c.abort();window.removeEventListener("storage",changed);window.removeEventListener("campus:session-expired",invalidate);};
  },[account,path,version]);
  return {data,error,loading,reload};
}
