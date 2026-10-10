//! Durable host-qualified jobs. Backend notifications never author ownership.
use super::{backend::{self,Broker,CallLease},service_host};
use crate::{error::AppError,service_state::{job::{JobRecord,JobState},model::PackageGeneration}};
use serde_json::{json,Value};
use std::{collections::HashSet,sync::{Arc,Mutex,OnceLock},time::{SystemTime,UNIX_EPOCH}};
fn error(message:&str)->AppError {AppError::Other(message.into())}
fn now()->u64 {SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis().min(9_007_199_254_740_991) as u64}
fn opaque(bytes:usize)->Result<String,AppError> {let mut value=vec![0;bytes];getrandom::fill(&mut value).map_err(|_|error("Could not allocate background operation identity"))?;Ok(hex::encode(value))}
static BOOT:OnceLock<String>=OnceLock::new();
pub(super) fn origin(label:&str)->Result<String,AppError> {
    if label.len()>64 || !label.bytes().all(|b|b.is_ascii_alphanumeric()||b"._-".contains(&b)) {return Err(error("Invalid background operation window"));}
    if BOOT.get().is_none(){let _=BOOT.set(opaque(24)?);}
    Ok(format!("{label}.{}",BOOT.get().expect("initialized")))
}
pub(super) fn register(owner:PackageGeneration,operation:&str,kind:&str,origin_window:&str)->Result<JobRecord,AppError> {
    let store=service_host::store()?;
    for _ in 0..8 {
        let mut bytes=[0u8;8];getrandom::fill(&mut bytes).map_err(|_|error("Could not allocate background operation ID"))?;
        let id=(u64::from_le_bytes(bytes)&((1<<51)-1))|(1<<51);
        let timestamp=now();
        let record=JobRecord {job_key:opaque(24)?,owner:owner.clone(),operation_id:operation.into(),job_id:id,kind:kind.into(),label:if kind=="openai-image" {"AI image".into()}else{kind.into()},origin_window:origin_window.into(),revision:0,source_revision:0,created_at_ms:timestamp,updated_at_ms:timestamp,state:JobState::Accepting,phase:Some("preparing".into()),output_path:None,run_id:None,error:None};
        // Collision refusal happens before plugin dispatch. Never reuse a key.
        match store.register_job(record) {Ok(record)=>{emit(&record);return Ok(record)},Err(cause) if cause.to_string().contains("identity already belongs")=>continue,Err(cause)=>return Err(cause)}
    }
    Err(error("Background operation identity capacity reached"))
}
fn emit(record:&JobRecord) {backend::emit_job_event(json!({"type":"updated","job":record}));}
fn observe(record:&JobRecord,status:&Value)->Result<JobRecord,AppError> {
    if status["jobId"].as_u64()!=Some(record.job_id) || status["operationId"].as_str()!=Some(&record.operation_id) {return Err(error("Consumer job receipt has a different native binding"));}
    let phase=status["recoveryState"].as_str().unwrap_or("recovering");
    let state=match status["status"].as_str() {
        Some("succeeded") if status["outputPath"].as_str().is_some_and(|v|!v.is_empty()) && status["runId"].as_i64().is_some_and(|v|v>0)=>JobState::Completed,
        Some("failed") if status["providerExecution"]["state"]=="failed"=>JobState::Error,
        Some("cancelled")=>JobState::Cancelled,
        Some("discarded")=>JobState::Discarded,
        Some("running") if phase!="needs_attention"=>JobState::Running,
        Some("pending")=>JobState::Accepting,
        _ if phase=="needs_attention"=>JobState::NeedsAttention,
        _=>JobState::Recovering,
    };
    let output=if state==JobState::Completed {status["outputPath"].as_str().map(str::to_owned)}else{None};
    let message=status["error"].as_str().map(str::to_owned);
    let current=service_host::store()?.job(&record.job_key)?.ok_or_else(||error("Background job is not retained"))?;
    if current.phase.as_deref()==Some("stopped") || current.phase.as_deref()==Some("provider_result_discarded") && state!=JobState::Discarded {return Ok(current)}
    if current.run_id.is_some() && current.run_id!=status["runId"].as_i64(){return Err(error("Consumer job receipt changed its original Trace run"));}
    service_host::store()?.observe_job(&record.owner,&record.job_key,status["revision"].as_u64().ok_or_else(||error("Consumer job receipt has no revision"))?,state,Some(phase.into()),output,status["runId"].as_i64(),message)
}
static STATUS_WORKERS:OnceLock<Mutex<HashSet<String>>>=OnceLock::new();
struct StatusWorker(String);
impl Drop for StatusWorker {fn drop(&mut self){STATUS_WORKERS.get().expect("initialized").lock().unwrap_or_else(|e|e.into_inner()).remove(&self.0);}}
pub(super) fn schedule_status(broker:Arc<Broker>,record:JobRecord) {
    schedule_reconcile(Some(broker),record);
}
fn schedule_reconcile(broker:Option<Arc<Broker>>,record:JobRecord) {
    let deadline=std::time::Instant::now()+std::time::Duration::from_secs(10);
    let workers=STATUS_WORKERS.get_or_init(Default::default);
    {
        let mut live=workers.lock().unwrap_or_else(|e|e.into_inner());
        if live.len()>=8 || !live.insert(record.job_key.clone()) {return;}
    }
    let owned=StatusWorker(record.job_key.clone());
    let spawned=std::thread::Builder::new().name("native-job-status".into()).spawn(move || {
        let _done=owned;
        let result=crate::native_deadline::scoped(deadline,|| {
            let broker=match broker {Some(broker)=>broker,None=>backend::ensure(&record.owner.package_id)?};
            let _lease={let _gate=super::read_lifecycle()?;if !broker.is_active(){return Err(error("Consumer unavailable"));}CallLease::acquire_method(&record.owner.package_id,"jobs.status")?};
            let current=broker.generation();
            if current.package_id!=record.owner.package_id || current.digest!=record.owner.digest {return Err(error("Consumer package changed"));}
            let status=broker.call("jobs.status",json!({"operationId":record.operation_id}))?;
            let updated=observe(&record,&status)?;
            if updated.state.terminal(){broker.finish_job(updated.job_id);}
            Ok::<_,AppError>(updated)
        });
        if let Ok(updated)=result {emit(&updated);}
    });
    if spawned.is_err(){backend::emit_operations_changed();}
}
pub(super) fn event(broker:Arc<Broker>,name:&str,payload:&Value)->Result<(),AppError> {
    let Some(operation)=payload["operationId"].as_str() else {return Ok(())};
    let owner=broker.generation();
    let Some(record)=service_host::store()?.job_for_operation(&owner.package_id,operation)? else {return Ok(())};
    if owner.digest!=record.owner.digest || payload["jobId"].as_u64()!=Some(record.job_id) || ![format!("{}-complete",record.kind),format!("{}-error",record.kind),format!("{}-progress",record.kind)].iter().any(|expected|expected==name) {return Err(error("Plugin event does not match its durable native job"));}
    if record.phase.as_deref()==Some("stopped") {return Ok(())}
    if name.ends_with("-progress") {
        if record.state.terminal(){return Ok(())}
        let updated=observe(&record,payload)?;emit(&updated);
    }else{schedule_status(broker,record);}
    Ok(())
}
pub(super) fn disconnected(owner:&PackageGeneration) {
    if let Ok(snapshot)=service_host::store().and_then(|s|s.snapshot_jobs()) {
        for record in snapshot.jobs.into_iter().filter(|r|r.owner==*owner&&!r.state.terminal()&&!matches!(r.phase.as_deref(),Some("stopped"|"provider_result_discarded"))) {
            if let Ok(record)=service_host::store().and_then(|s|s.update_job(&record.owner,&record.job_key,JobState::Recovering,Some("recovering".into()),None,record.run_id,None)) {emit(&record);}
        }
    }
}
pub(super) fn initialize()->Result<(),AppError> {
    for record in service_host::store()?.recover_jobs(None)? {emit(&record)}
    // Snapshot/status reconciliation is unpaid and owns at most eight workers.
    // Attention records remain retained until an explicit recovery action.
    std::thread::spawn(|| {
        while !backend::is_closing() {
            if let Ok(snapshot)=service_host::store().and_then(|s|s.snapshot_jobs()) {
                for record in snapshot.jobs.into_iter().filter(|r|matches!(r.state,JobState::Accepting|JobState::Running|JobState::Recovering)) {
                    if now().saturating_sub(record.created_at_ms)>600_000 {
                        if let Ok(updated)=service_host::store().and_then(|s|s.update_job(&record.owner,&record.job_key,JobState::NeedsAttention,Some("needs_attention".into()),None,record.run_id,Some("Recovery requires attention; the original operation has not been replayed".into()))) {emit(&updated);}
                        continue;
                    }
                    schedule_reconcile(None,record);
                }
            }
            std::thread::sleep(std::time::Duration::from_secs(2));
        }
    });
    Ok(())
}
pub(super) fn snapshot(label:&str)->Result<Value,AppError> {
    let snapshot=service_host::store()?.snapshot_jobs()?;
    Ok(json!({"originWindow":origin(label)?,"watermark":snapshot.watermark,"jobs":snapshot.jobs}))
}
pub(super) fn cancel(key:&str)->Result<Value,AppError> {
    let record=service_host::store()?.job(key)?.ok_or_else(||error("Background operation is no longer retained"))?;
    if record.state.terminal() {return Ok(json!(record))}
    if record.phase.as_deref()==Some("stopped"){return Err(error("Automatic recovery was explicitly stopped; its unknown execution evidence remains retained"));}
    let broker=backend::ensure(&record.owner.package_id)?;
    if broker.generation().digest!=record.owner.digest {return Err(error("Enable the original consumer package before cancelling this operation"));}
    let _lease={let _gate=super::read_lifecycle()?;if !broker.is_active(){return Err(error("Consumer is unavailable"));}CallLease::acquire_method(&record.owner.package_id,"jobs.cancelOperation")?};
    broker.call("jobs.cancelOperation",json!({"operationId":record.operation_id}))?;
    schedule_status(broker,record.clone());Ok(json!(record))
}
pub(super) fn resume(key:&str)->Result<Value,AppError> {
    let _action=super::ai_operations::action_guard()?;
    let record=service_host::store()?.job(key)?.ok_or_else(||error("Background operation is no longer retained"))?;
    if record.state.terminal() {return Ok(json!(record))}
    if record.phase.as_deref()==Some("stopped"){return Err(error("Automatic recovery was explicitly stopped; its unknown execution evidence remains retained"));}
    let broker=backend::ensure(&record.owner.package_id)?;
    if broker.generation().digest!=record.owner.digest {return Err(error("Enable the original consumer package before recovering this operation"));}
    let _lease={let _gate=super::read_lifecycle()?;if !broker.is_active(){return Err(error("Consumer is unavailable"));}CallLease::acquire_method(&record.owner.package_id,"jobs.resumeOperation")?};
    broker.call("jobs.resumeOperation",json!({"operationId":record.operation_id}))?;
    let updated=service_host::store()?.update_job(&record.owner,&record.job_key,JobState::Recovering,Some("recovering".into()),None,record.run_id,None)?;
    emit(&updated);schedule_status(broker,updated.clone());Ok(json!(updated))
}

pub(super) fn rejected(record:&JobRecord,cause:&AppError,broker:&Broker,status:&Value)->Result<(),AppError> {
    let definite=matches!(cause,AppError::Service{code,..} if !matches!(code.as_str(),"timed_out"|"worker_failed"|"mutation_uncertain"|"transport_unavailable"|"protocol_error"));
    if !definite || !broker.is_active() || !status.is_null() || service_host::store()?.get(&record.owner.package_id,&record.operation_id)?.is_some(){return Ok(())}
    // A completed native rejection + no durable local/service acceptance is
    // distinct from a transport loss. Fence this original UUID before settling.
    broker.call("jobs.cancelOperation",json!({"operationId":record.operation_id}))?;
    let status=broker.call("jobs.status",json!({"operationId":record.operation_id}))?;
    if !status.is_null() || service_host::store()?.get(&record.owner.package_id,&record.operation_id)?.is_some(){return Ok(())}
    let updated=service_host::store()?.update_job(&record.owner,&record.job_key,JobState::Error,Some("not_accepted".into()),None,None,Some("Image request was rejected before acceptance; review its inputs and connection settings".into()))?;
    broker.finish_job(record.job_id);emit(&updated);Ok(())
}
