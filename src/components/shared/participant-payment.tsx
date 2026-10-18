"use client";
import {useEffect,useRef,useState} from "react";
import {usePaymentRead,usePaymentRequest} from "./payment-request";
import {ResourceState} from "./ui";
import {cents,reason,type PaymentView,type PaymentAttempt} from "./payment-model";
import {MoneyPlan,Confirmations,ConsentButton,FundingStatus,PaymentRecovery,HostedAction} from "./payment-presentation";
import {PaymentCases} from "./payment-cases";
import {FeeRevisionPanel} from "./payment-fee-revision";
export function ParticipantPayment({account,id,kind,onChanged}:{account:string;id:string;kind:"agreement"|"order";onChanged:()=>void}) {
 const base=`${kind==='agreement'?'agreements':'orders'}/${id}`;
 const resource=usePaymentRead<PaymentView>(account,`${base}/participant-payment`),command=usePaymentRequest(account,`${kind}:${id}`);
 const [notice,setNotice]=useState("");const heading=useRef<HTMLHeadingElement>(null);
 const d=resource.data,f=d?.funding,fp=d?.feePlan,q=d?.quote;
 const attempt=usePaymentRead<PaymentAttempt>(account,f?.activeAttempt?`payment-attempts/${f.activeAttempt.id}`:null);
 function refresh(){resource.reload();attempt.reload();onChanged();}
 useEffect(()=>{const fn=()=>refresh();window.addEventListener('focus',fn);return ()=>window.removeEventListener('focus',fn);},[account,id]);
 async function act(path:string,body:Record<string,unknown>,expected:Record<string,unknown>={},required:string[]=[]){const r=await command.send(path,body,expected,required);if(r){setNotice("Request recorded. Current payment status is shown separately below.");refresh();heading.current?.focus();}return r;}
 if(!d)return <section className="cb-panel" aria-label="Payments"><h2>Payment and recipient transfers</h2><ResourceState {...resource}/><PaymentRecovery command={command} refresh={refresh}/></section>;
 const disabled=command.blocked||!d.paymentEnabled;
 const collectionDisabled=disabled||!!d.configurationChangeBlocker;
 const policy=d.orderPolicy;
 const quoteAllowed=fp?.allowedActions.includes('request_quote')||f!.allowedActions.includes('request_quote');
 return <section className="cb-panel" aria-label="Payments"><h2 ref={heading} tabIndex={-1}>Payment and recipient transfers</h2>
 <p role="status" aria-live="polite">{command.busy?"Saving your exact request…":notice}</p>
 {!d.paymentEnabled&&<p className="cb-alert">{reason('payments_unavailable')}</p>}
 <FundingStatus funding={f!} people={d.people} account={account}/>
 {d.preparationBlocker&&<p className="cb-alert">{reason(d.preparationBlocker)}</p>}
 {!f!.obligationId&&<button className="cb-button" disabled={disabled||!!d.preparationBlocker} onClick={()=>void act(`${base}/payment-preparation`,{},{resourceId:id},['policyVersionId','policyDigest'])}>Prepare current financial terms</button>}
 {!fp&&d.feePlanBlocker&&<p>{reason(d.feePlanBlocker)}. Prepare current terms, then review the amounts before confirming.</p>}
 {policy?.policyVersionId&&<details open><summary>Buyer and seller transaction terms</summary><p>Goods principal {cents(policy.sellerGrossCents)} · estimated buyer total {cents(policy.buyerPayableCents)} · seller estimated fee {cents(policy.sellerFeeCents)} · seller estimated net {cents(policy.sellerNetCents)}.</p>{Object.values(policy.policy?.disclosure??{}).filter(v=>typeof v==='object').map((v,i)=><p key={i}><strong>{v.title}</strong>: {v.description}</p>)}<p>Buyer confirms receipt before seller release eligibility. Active disputes pause release; time passing does not authorize release.</p><Confirmations people={d.people} required={d.people.map(p=>p.id)} confirmed={policy.confirmations} account={account}/>{!policy.confirmations.includes(account)&&<ConsentButton identity={policy.policyDigest!} disabled={disabled} label="Confirm order financial terms" onConfirm={()=>void act(`${base}/payment-policy-confirmations`,{expectedPaymentRevision:policy.paymentRevision,orderTermsDigest:policy.orderTermsDigest,policyVersionId:policy.policyVersionId,policyDigest:policy.policyDigest},{orderId:id,userId:account,policyVersionId:policy.policyVersionId,policyDigest:policy.policyDigest})}/>}</details>}
 {fp?.allowedActions.includes('propose_fee_plan')&&<button className="cb-button" disabled={disabled} onClick={()=>void act(`${base}/fee-plans`,{policyVersionId:fp.context.policyId,policyDigest:fp.context.policyDigest,sourceDigest:fp.context.sourceDigest},{},['planId','digest'])}>Review exact upfront fee reserve</button>}
 {fp?.plan&&<div><h3>Exact fee reserve and personal consent</h3>{Object.values(d.approvedDisclosures??{}).filter(v=>typeof v==='object').map((v,i)=><p key={i}><strong>{v.title}</strong>: {v.description}</p>)}<p>Platform service fee $0.00. Estimated processing cost {cents(fp.plan.estimatedFeeCents)}; preconsented extra total cap {cents(fp.plan.additionalFeeCapCents)}; maximum total processing cost {cents(fp.plan.maximumFeeCents)}. Payer maximum share {cents(fp.plan.maximumPayerFeeCents)}; recipients maximum combined share {cents(fp.plan.maximumRecipientFeeCents)}.</p><MoneyPlan original={fp.plan.originalPlan} maximum={fp.plan.maximumPlan} people={d.people} account={account}/><p>{fp.plan.restoration}</p><Confirmations people={d.people} required={fp.context.participants} confirmed={fp.confirmedParticipantIds} account={account}/>{fp.allowedActions.includes('confirm_fee_plan')&&<ConsentButton identity={fp.digest!} disabled={disabled} label="Confirm my exact fee reserve" onConfirm={()=>void act(`payment-fee-plans/${fp.planId}/confirmations`,{digest:fp.digest},{planId:fp.planId,digest:fp.digest,userId:account})}/>}</div>}
 {quoteAllowed&&d.quoteRequest&&<button className="cb-button" disabled={disabled} onClick={()=>void act(`${base}/payment-quotes`,d.quoteRequest!,{},['quoteId','quoteDigest','obligationId'])}>{q?'Review a current payment quote':'Get current payment quote'}</button>}
 {q&&<div className="cb-alert"><h3>Explicit payer payment</h3><p>Current quoted collection: <strong>{cents(q.amountCents)}</strong>. Quote expires {new Date(q.expiresAt).toLocaleString()}. Opening Checkout does not prove payment.</p>{new Date(q.expiresAt).getTime()<=Date.now()?<p>This quote expired. Request and review a current quote before paying.</p>:!f!.activeAttempt&&<ConsentButton identity={q.quoteDigest} disabled={collectionDisabled||!f!.allowedActions.includes('create_payment_attempt')} label={`Start payment of ${cents(q.amountCents)}`} onConfirm={()=>void act(`funding-obligations/${q.obligationId}/payment-attempts`,{quoteId:q.quoteId,quoteDigest:q.quoteDigest,expectedObligationRevision:q.obligationRevision,acceptedAmountCents:q.amountCents,currency:'USD'},{obligationId:q.obligationId,quoteId:q.quoteId,amountCents:q.amountCents,currency:'USD'},['attemptId','operationId'])}/>}</div>}
 {f!.activeAttempt&&<div role="status"><p>Current payment attempt: {reason(attempt.data?.status??f!.activeAttempt.status)}. If its result is unknown, retain this attempt and refresh.</p>{attempt.data?.hostedUrl&&<HostedAction account={account} path={`payment-attempts/${attempt.data.attemptId}`} label="Continue this payment in hosted Checkout"/>}</div>}
 {f!.obligationId&&<><FeeRevisionPanel payerId={fp?.context.payerId??null} paymentEnabled={d.paymentEnabled} account={account} obligationId={f!.obligationId} people={d.people} command={command} onChanged={refresh}/><PaymentCases view={d} account={account} base={base} command={command} onChanged={refresh}/></>}
 <PaymentRecovery command={command} refresh={refresh}/>
 </section>;
}
