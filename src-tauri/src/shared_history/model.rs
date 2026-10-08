//! Pure bounded history policy; clients provide the existing directoryKey identity.
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
pub struct RecentEntry {
    pub name: String,
    pub path: String,
    pub kind: String,
    pub timestamp: f64,
    #[serde(default)]
    pub revision: u64,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FrecencyEntry {
    pub path: String,
    pub accesses: Vec<f64>,
    #[serde(default)]
    pub revision: u64,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub dismissed_from_recent: bool,
}
#[derive(Default, Clone, Debug, Deserialize, Serialize, PartialEq)]
pub struct Snapshot {
    pub recent: Vec<RecentEntry>,
    pub frecency: Vec<FrecencyEntry>,
}
#[derive(Deserialize)]
pub struct Keyed<T> {
    pub key: String,
    pub entry: T,
}
#[derive(Default, Deserialize)]
pub struct Seed {
    pub recent: Vec<Keyed<RecentEntry>>,
    pub frecency: Vec<Keyed<FrecencyEntry>>,
}
#[derive(Default, Deserialize, Serialize)]
pub struct Document {
    #[serde(default)]
    pub revision: u64,
    pub recent: BTreeMap<String, RecentEntry>,
    pub frecency: BTreeMap<String, FrecencyEntry>,
}
#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Collection {
    Recent,
    Frecency,
}
#[derive(Deserialize)]
pub struct ObservedEntry {
    pub key: String,
    pub revision: u64,
}
#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum Mutation {
    Recent {
        key: String,
        entry: RecentEntry,
    },
    Access {
        key: String,
        path: String,
        timestamp: f64,
    },
    Remove {
        collection: Collection,
        keys: Vec<String>,
    },
    Prune {
        collection: Collection,
        entries: Vec<ObservedEntry>,
    },
    Clear {
        collection: Collection,
    },
    Downvote {
        key: String,
        dismiss: bool,
    },
}
fn valid_path(value: &str) -> bool {
    !value.is_empty() && value.len() <= 131072 && !value.contains('\0')
}
fn valid_time(value: f64) -> bool {
    value.is_finite() && value >= 0.0
}
fn score(entry: &FrecencyEntry, now: f64) -> f64 {
    entry
        .accesses
        .iter()
        .map(|time| 1.0 / (1.0 + ((now - time) / 3_600_000.0).max(0.0)))
        .sum()
}
impl Document {
    pub fn from_seed(seed: Seed) -> Self {
        let mut document = Self::default();
        for item in seed.recent.into_iter().take(50) {
            if valid_path(&item.key)
                && valid_path(&item.entry.path)
                && valid_time(item.entry.timestamp)
                && matches!(item.entry.kind.as_str(), "file" | "directory")
                && item.entry.name.len() <= 16384
            {
                document.revision = document.revision.max(item.entry.revision);
                document.recent.insert(item.key, item.entry);
            }
        }
        for mut item in seed.frecency.into_iter().take(200) {
            if !valid_path(&item.key) || !valid_path(&item.entry.path) {
                continue;
            }
            item.entry.accesses.retain(|time| valid_time(*time));
            let discard = item.entry.accesses.len().saturating_sub(10);
            item.entry.accesses.drain(..discard);
            document.revision = document.revision.max(item.entry.revision);
            document.frecency.insert(item.key, item.entry);
        }
        document
    }
    pub fn snapshot(&self) -> Snapshot {
        let mut recent: Vec<_> = self.recent.values().cloned().collect();
        recent.sort_by(|a, b| {
            b.timestamp
                .total_cmp(&a.timestamp)
                .then(a.path.cmp(&b.path))
        });
        Snapshot {
            recent,
            frecency: self.frecency.values().cloned().collect(),
        }
    }
    fn next_revision(&mut self) -> Result<u64, &'static str> {
        self.revision = self
            .revision
            .checked_add(1)
            .filter(|revision| *revision <= 9_007_199_254_740_991)
            .ok_or("History revision exhausted")?;
        Ok(self.revision)
    }
    pub fn apply(&mut self, operation: Mutation) -> Result<(), &'static str> {
        match operation {
            Mutation::Recent { key, mut entry } => {
                if !valid_path(&key)
                    || !valid_path(&entry.path)
                    || !valid_time(entry.timestamp)
                    || !matches!(entry.kind.as_str(), "file" | "directory")
                    || entry.name.len() > 16384
                {
                    return Err("Invalid recent history entry");
                }
                entry.revision = self.next_revision()?;
                self.recent.insert(key, entry);
                if self.recent.len() > 50 {
                    let oldest = self
                        .recent
                        .iter()
                        .min_by(|a, b| a.1.timestamp.total_cmp(&b.1.timestamp))
                        .map(|(key, _)| key.clone())
                        .unwrap();
                    self.recent.remove(&oldest);
                }
            }
            Mutation::Access {
                key,
                path,
                timestamp,
            } => {
                if !valid_path(&key) || !valid_path(&path) || !valid_time(timestamp) {
                    return Err("Invalid history access");
                }
                let revision = self.next_revision()?;
                let entry = self.frecency.entry(key).or_insert_with(|| FrecencyEntry {
                    path,
                    revision: 0,
                    accesses: vec![],
                    dismissed_from_recent: false,
                });
                entry.revision = revision;
                entry.accesses.push(timestamp);
                let discard = entry.accesses.len().saturating_sub(10);
                entry.accesses.drain(..discard);
                entry.dismissed_from_recent = false;
                if self.frecency.len() > 200 {
                    let least = self
                        .frecency
                        .iter()
                        .min_by(|a, b| score(a.1, timestamp).total_cmp(&score(b.1, timestamp)))
                        .map(|(key, _)| key.clone())
                        .unwrap();
                    self.frecency.remove(&least);
                }
            }
            Mutation::Remove { collection, keys } => {
                if keys.len() > 200 {
                    return Err("Too many history removals");
                }
                for key in keys {
                    match collection {
                        Collection::Recent => {
                            self.recent.remove(&key);
                        }
                        Collection::Frecency => {
                            self.frecency.remove(&key);
                        }
                    }
                }
            }
            Mutation::Prune {
                collection,
                entries,
            } => {
                if entries.len() > 200 {
                    return Err("Too many history removals");
                }
                for observed in entries {
                    match collection {
                        Collection::Recent => {
                            if self
                                .recent
                                .get(&observed.key)
                                .is_some_and(|entry| entry.revision == observed.revision)
                            {
                                self.recent.remove(&observed.key);
                            }
                        }
                        Collection::Frecency => {
                            if self
                                .frecency
                                .get(&observed.key)
                                .is_some_and(|entry| entry.revision == observed.revision)
                            {
                                self.frecency.remove(&observed.key);
                            }
                        }
                    }
                }
            }
            Mutation::Clear { collection } => match collection {
                Collection::Recent => self.recent.clear(),
                Collection::Frecency => self.frecency.clear(),
            },
            Mutation::Downvote { key, dismiss } => {
                if self.frecency.contains_key(&key) {
                    let revision = self.next_revision()?;
                    let entry = self.frecency.get_mut(&key).unwrap();
                    entry.revision = revision;
                    entry.accesses.sort_by(f64::total_cmp);
                    entry.accesses.truncate(entry.accesses.len() / 2);
                    entry.dismissed_from_recent |= dismiss;
                    if entry.accesses.is_empty() {
                        self.frecency.remove(&key);
                    }
                }
            }
        }
        Ok(())
    }
}
