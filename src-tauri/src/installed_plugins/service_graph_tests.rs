use super::package::{Installed, ServiceDependency, ServiceExport};
use super::service_graph::*;
fn package(id: &str) -> Installed {
    Installed { enabled:true, digest:"a".repeat(64), manifest:serde_json::from_value(serde_json::json!({"formatVersion":1,"id":id,"name":id,"description":"","version":"1.0.0","sdkVersion":3,"svelteVersion":"5.56.3","target":"fixture","frontend":"index.js","styles":"index.css","backend":"worker","contributions":["fixture"],"files":{}})).unwrap() }
}
fn export(entry: &mut Installed) {
    entry.manifest.services.push(ServiceExport {
        id: "image-generation".into(),
        major: 1,
        methods: vec!["describe".into(), "start".into(), "status".into()],
    });
}
fn dependency(entry: &mut Installed, target: &str, optional: bool) {
    entry.manifest.service_dependencies.push(ServiceDependency {
        package_id: target.into(),
        service_id: "image-generation".into(),
        major: 1,
        optional,
    });
}
#[test]
fn optional_absence_preserves_consumer_but_does_not_route() {
    let mut consumer = package("example.trace");
    dependency(&mut consumer, "example.images", true);
    assert!(validate_enabled(&[consumer.clone()]).is_ok());
    assert!(select(
        &[],
        &consumer.manifest,
        "example.images",
        "image-generation",
        1
    )
    .is_err());
}
#[test]
fn exact_declared_package_version_and_enablement_required() {
    let mut consumer = package("example.trace");
    dependency(&mut consumer, "example.images", false);
    let mut provider = package("example.images");
    export(&mut provider);
    let entries = [consumer.clone(), provider.clone()];
    assert!(validate_enabled(&entries).is_ok());
    assert!(select(
        &entries,
        &consumer.manifest,
        "other.images",
        "image-generation",
        1
    )
    .is_err());
    assert!(select(
        &entries,
        &consumer.manifest,
        "example.images",
        "image-generation",
        2
    )
    .is_err());
    provider.enabled = false;
    assert!(validate_enabled(&[consumer, provider]).is_err());
}
#[test]
fn cycles_are_rejected_even_when_edges_are_optional() {
    let mut a = package("example.a");
    let mut b = package("example.b");
    export(&mut a);
    export(&mut b);
    dependency(&mut a, "example.b", true);
    dependency(&mut b, "example.a", true);
    assert!(validate_enabled(&[a, b]).is_err());
}
#[test]
fn old_sdk_and_private_method_declarations_are_rejected() {
    let mut entry = package("example.a");
    export(&mut entry);
    entry.manifest.sdk_version = 2;
    assert!(validate_declarations(&entry.manifest).is_err());
    entry.manifest.sdk_version = 3;
    entry.manifest.services[0]
        .methods
        .push("host.credentials.get".into());
    assert!(validate_declarations(&entry.manifest).is_err());
}
#[test]
fn duplicate_and_self_dependencies_fail_before_startup() {
    let mut entry = package("example.a");
    dependency(&mut entry, "example.a", false);
    assert!(validate_declarations(&entry.manifest).is_err());
    entry.manifest.service_dependencies.clear();
    dependency(&mut entry, "example.b", true);
    dependency(&mut entry, "example.b", false);
    assert!(validate_declarations(&entry.manifest).is_err());
}
#[test]
fn duplicate_service_exports_are_rejected_but_distinct_majors_are_not() {
    let mut entry = package("example.images");
    export(&mut entry);
    let mut next_major = entry.manifest.services[0].clone();
    next_major.major = 2;
    entry.manifest.services.push(next_major);
    assert!(validate_declarations(&entry.manifest).is_ok());
    export(&mut entry);
    assert!(validate_declarations(&entry.manifest).is_err());
    assert!(validate_enabled(&[entry]).is_err());
}
#[test]
fn calls_route_only_declared_targets_and_exported_methods() {
    let mut consumer = package("example.trace");
    dependency(&mut consumer, "example.images", false);
    let mut provider = package("example.images");
    export(&mut provider);
    let mut unrelated = package("example.other");
    export(&mut unrelated);
    let entries = [consumer.clone(), provider, unrelated];
    let route = |target: &str, method: &str| {
        route(
            &entries,
            &consumer.manifest,
            target,
            "image-generation",
            1,
            method,
        )
        .map(|(provider, _)| provider.manifest.id.clone())
    };
    assert_eq!(route("example.images", "start").unwrap(), "example.images");
    // Exported by a package the caller never declared.
    assert!(route("example.other", "start").is_err());
    // A method the selected provider does not export.
    assert!(route("example.images", "acknowledge").is_err());
    assert!(route("example.images", "host.credentials.resolve").is_err());
}
#[test]
fn an_absent_required_dependency_fails_while_an_absent_optional_one_does_not() {
    let mut consumer = package("example.trace");
    dependency(&mut consumer, "example.images", false);
    assert!(validate_enabled(std::slice::from_ref(&consumer)).is_err());
    consumer.manifest.service_dependencies[0].optional = true;
    assert!(validate_enabled(&[consumer]).is_ok());
}
