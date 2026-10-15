//! Durable host ownership, independent of provider execution and plugin RPC.
mod artifacts;
mod host_spools;
pub(crate) use host_spools::HostSpoolWriter;
mod intents;
pub(crate) mod job;
mod job_store;
pub(crate) mod model;
pub(crate) mod receipt;
mod receipts;
pub(crate) mod request;
mod rules;
mod store;
#[cfg(test)]
pub(crate) mod test_fs;
pub(crate) use store::Store;
#[cfg(test)]
mod tests;
