//! Pure, exact-package service selection. No startup, IO or provider execution.
use super::package::{identifier, service_identifier, Installed, Manifest, ServiceExport};
use crate::error::AppError;
use std::collections::{HashMap, HashSet};

fn invalid(message: &str) -> AppError {
    AppError::Other(message.into())
}

pub(super) fn validate_declarations(manifest: &Manifest) -> Result<(), AppError> {
    if manifest.sdk_version < 3
        && (!manifest.services.is_empty() || !manifest.service_dependencies.is_empty())
    {
        return Err(invalid("Plugin services require SDK 3"));
    }
    if manifest.services.len() > 16 || manifest.service_dependencies.len() > 16 {
        return Err(invalid("Too many plugin service declarations"));
    }
    let mut exports = HashSet::new();
    for service in &manifest.services {
        if !service_identifier(&service.id)
            || service.major == 0
            || service.major > 65535
            || !exports.insert((&service.id, service.major))
            || service.methods.is_empty()
            || service.methods.len() > 32
            || service.methods.iter().any(|method| {
                !service_identifier(method) || matches!(method.as_str(), "initialize" | "activate")
            })
            || service.methods.iter().collect::<HashSet<_>>().len() != service.methods.len()
        {
            return Err(invalid("Invalid plugin service export"));
        }
    }
    let mut dependencies = HashSet::new();
    for dependency in &manifest.service_dependencies {
        if !identifier(&dependency.package_id)
            || dependency.package_id == manifest.id
            || !service_identifier(&dependency.service_id)
            || dependency.major == 0
            || dependency.major > 65535
            || !dependencies.insert((
                &dependency.package_id,
                &dependency.service_id,
                dependency.major,
            ))
        {
            return Err(invalid("Invalid plugin service dependency"));
        }
    }
    Ok(())
}

pub(super) fn select<'a>(
    entries: &'a [Installed],
    consumer: &Manifest,
    package_id: &str,
    service_id: &str,
    major: u32,
) -> Result<(&'a Installed, &'a ServiceExport), AppError> {
    if !consumer.service_dependencies.iter().any(|dep| {
        dep.package_id == package_id && dep.service_id == service_id && dep.major == major
    }) {
        return Err(invalid("Plugin did not declare this service dependency"));
    }
    let provider = entries
        .iter()
        .find(|entry| entry.manifest.id == package_id && entry.enabled)
        .ok_or_else(|| invalid("Required service package is unavailable"))?;
    let export = provider
        .manifest
        .services
        .iter()
        .find(|export| export.id == service_id && export.major == major)
        .ok_or_else(|| invalid("Required service version is unavailable"))?;
    Ok((provider, export))
}

/// Call-time routing: the caller must declare the exact dependency and the
/// selected provider generation must export the requested method.
pub(super) fn route<'a>(
    entries: &'a [Installed],
    consumer: &Manifest,
    package_id: &str,
    service_id: &str,
    major: u32,
    method: &str,
) -> Result<(&'a Installed, &'a ServiceExport), AppError> {
    let (provider, export) = select(entries, consumer, package_id, service_id, major)?;
    if !export.methods.iter().any(|exported| exported == method) {
        return Err(invalid("Provider does not export this service method"));
    }
    Ok((provider, export))
}

/// Required edges must resolve; unavailable optional edges preserve the consumer.
/// Present edges participate in cycle detection before any backend starts.
pub(super) fn validate_enabled(entries: &[Installed]) -> Result<(), AppError> {
    let mut edges = HashMap::<&str, Vec<&str>>::new();
    for consumer in entries.iter().filter(|entry| entry.enabled) {
        validate_declarations(&consumer.manifest)?;
        let targets = edges.entry(&consumer.manifest.id).or_default();
        for dep in &consumer.manifest.service_dependencies {
            match select(
                entries,
                &consumer.manifest,
                &dep.package_id,
                &dep.service_id,
                dep.major,
            ) {
                Ok((provider, _)) => targets.push(&provider.manifest.id),
                Err(_) if dep.optional => {}
                Err(cause) => return Err(cause),
            }
        }
    }
    fn visit<'a>(
        id: &'a str,
        edges: &HashMap<&'a str, Vec<&'a str>>,
        visiting: &mut HashSet<&'a str>,
        done: &mut HashSet<&'a str>,
    ) -> bool {
        if done.contains(id) {
            return true;
        }
        if !visiting.insert(id) {
            return false;
        }
        if edges
            .get(id)
            .into_iter()
            .flatten()
            .any(|target| !visit(target, edges, visiting, done))
        {
            return false;
        }
        visiting.remove(id);
        done.insert(id);
        true
    }
    let mut visiting = HashSet::new();
    let mut done = HashSet::new();
    if edges
        .keys()
        .any(|id| !visit(id, &edges, &mut visiting, &mut done))
    {
        return Err(invalid("Plugin service dependency cycle"));
    }
    Ok(())
}
