use super::model::*;
use crate::error::AppError;
pub(super) type Result<T> = std::result::Result<T, AppError>;
pub(super) fn reject(message: &str) -> AppError {
    AppError::Other(format!("Service state: {message}"))
}
pub(super) fn identity(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 256
        && value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"._-:".contains(&c))
}
pub(super) fn digest(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
}
pub(super) fn generation(value: &PackageGeneration) -> Result<()> {
    if !identity(&value.package_id) || !digest(&value.digest) || value.incarnation == 0 {
        Err(reject("invalid package generation"))
    } else {
        Ok(())
    }
}
pub(super) fn same_owner(a: &PackageGeneration, b: &PackageGeneration) -> bool {
    a.package_id == b.package_id && a.digest == b.digest
}
pub(super) fn descriptor(value: &ArtifactDescriptor) -> Result<()> {
    if !identity(&value.handle)
        || !digest(&value.sha256)
        || value.byte_length == 0
        || value.byte_length > 50 * 1024 * 1024
        || !matches!(
            value.media_type.as_str(),
            "image/png" | "image/jpeg" | "image/webp"
        )
    {
        Err(reject("invalid artifact descriptor"))
    } else {
        Ok(())
    }
}
pub(super) fn admission(value: &Admission) -> Result<()> {
    generation(&value.consumer)?;
    generation(&value.provider)?;
    if !identity(&value.operation_id)
        || !digest(&value.fingerprint)
        || value.target.package_id != value.provider.package_id
        || !identity(&value.target.service_id)
        || value.target.major != 1
        || value.inputs.len() > 8
    {
        return Err(reject("invalid admission"));
    }
    for input in &value.inputs {
        descriptor(input)?;
    }
    if value.phase != AdmissionPhase::Reserved
        || value.output.is_some()
        || value.disposition.is_some()
        || value.transfer_receipt.is_some()
        || value.needs_attention
    {
        return Err(reject("new admissions must be reserved"));
    }
    Ok(())
}
pub(super) fn transition(from: AdmissionPhase, to: AdmissionPhase) -> Result<()> {
    if from == to
        || matches!(
            (from, to),
            (AdmissionPhase::Reserved, AdmissionPhase::Forwarding)
                | (AdmissionPhase::Forwarding, AdmissionPhase::Accepted)
                | (AdmissionPhase::Forwarding, AdmissionPhase::Terminal)
                | (AdmissionPhase::Accepted, AdmissionPhase::Terminal)
                | (AdmissionPhase::Terminal, AdmissionPhase::Released)
        )
    {
        Ok(())
    } else {
        Err(reject("invalid admission phase transition"))
    }
}
pub(super) fn phase(value: AdmissionPhase) -> &'static str {
    match value {
        AdmissionPhase::Reserved => "reserved",
        AdmissionPhase::Forwarding => "forwarding",
        AdmissionPhase::Accepted => "accepted",
        AdmissionPhase::Terminal => "terminal",
        AdmissionPhase::Released => "released",
    }
}
pub(super) fn persisted(value: &Admission) -> Result<()> {
    generation(&value.consumer)?;
    generation(&value.provider)?;
    if !identity(&value.operation_id)
        || !digest(&value.fingerprint)
        || value.target.package_id != value.provider.package_id
        || !identity(&value.target.service_id)
        || value.target.major == 0
        || value.inputs.len() > 8
    {
        return Err(reject("durable admission identity is malformed"));
    }
    for input in &value.inputs {
        descriptor(input)?;
    }
    if let Some(output) = &value.output {
        descriptor(output)?;
        if output.media_type != "image/png" {
            return Err(reject("durable output format is invalid"));
        }
    }
    if !matches!(
        value.phase,
        AdmissionPhase::Terminal | AdmissionPhase::Released
    ) && value.output.is_some()
    {
        return Err(reject("nonterminal admission has terminal output"));
    }
    if value.phase == AdmissionPhase::Released {
        match value.disposition.as_deref() {
            Some("acquired")
                if value.output.is_some()
                    && value.transfer_receipt.as_ref().is_some_and(|s| identity(s)) => {}
            Some("discarded" | "never_forwarded") if value.transfer_receipt.is_none() => {}
            _ => return Err(reject("released admission lacks a valid disposition")),
        }
    } else if value.disposition.is_some() || value.transfer_receipt.is_some() {
        return Err(reject("unreleased admission has a released disposition"));
    }
    Ok(())
}
