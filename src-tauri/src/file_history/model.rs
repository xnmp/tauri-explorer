//! File history policy. No runtime, window, IPC, or filesystem dependencies.
use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, sync::Arc};

pub type ClientId = u64;
pub type EntryId = u64;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Action {
    Rename {
        path: String,
        old_name: String,
        new_name: String,
    },
    Move {
        source_path: String,
        dest_path: String,
        original_dir: String,
    },
    Copy {
        copied_path: String,
        parent_dir: String,
        #[serde(default)]
        restore_supported: bool,
    },
    Batch {
        actions: Vec<Action>,
        label: String,
    },
    Delete {
        paths: Vec<String>,
        parent_dir: String,
    },
}

impl Action {
    pub fn retained_bytes(&self) -> usize {
        std::mem::size_of::<Self>()
            + match self {
                Self::Rename {
                    path,
                    old_name,
                    new_name,
                } => path.capacity() + old_name.capacity() + new_name.capacity(),
                Self::Move {
                    source_path,
                    dest_path,
                    original_dir,
                } => source_path.capacity() + dest_path.capacity() + original_dir.capacity(),
                Self::Copy {
                    copied_path,
                    parent_dir,
                    ..
                } => copied_path.capacity() + parent_dir.capacity(),
                Self::Delete { paths, parent_dir } => {
                    parent_dir.capacity()
                        + paths.capacity() * std::mem::size_of::<String>()
                        + paths.iter().map(String::capacity).sum::<usize>()
                }
                Self::Batch { actions, label } => {
                    label.capacity()
                        + actions.capacity() * std::mem::size_of::<Action>()
                        + actions
                            .iter()
                            .map(|action| action.retained_bytes() - std::mem::size_of::<Action>())
                            .sum::<usize>()
                }
            }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Direction {
    Undo,
    Redo,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    pub revision: u64,
    pub undo_id: Option<EntryId>,
    pub redo_id: Option<EntryId>,
    pub stack_size: usize,
    pub busy: bool,
}

/// Completed effects and their recoverable opposite are distinct. Undoing a
/// copy can remove it on a platform that cannot subsequently restore it.
#[derive(Clone, Debug, Default)]
pub struct Execution {
    pub completed: Option<Action>,
    pub opposite: Option<Action>,
    pub remaining: Option<Action>,
    pub error: Option<String>,
}

#[derive(Clone, Debug)]
struct Entry {
    id: EntryId,
    action: Action,
    bytes: usize,
}

#[derive(Default)]
struct History {
    undo: Vec<Arc<Entry>>,
    redo: Vec<Arc<Entry>>,
    generation: u64,
    branch: u64,
}

#[derive(Clone, Debug)]
struct Ticket {
    client: ClientId,
    generation: u64,
    branch: u64,
}

#[derive(Clone, Debug)]
pub struct Reservation {
    pub id: EntryId,
    pub action: Action,
    pub direction: Direction,
    tickets: Vec<Ticket>,
}

/// One application authority, with independent window histories and explicitly
/// shared transfer entries. The active inverse may outlive any participant.
#[derive(Default)]
pub struct Histories {
    clients: BTreeMap<ClientId, History>,
    next_entry: EntryId,
    revision: u64,
    running: Option<EntryId>,
}

const MAX_ENTRIES: usize = 256;
const MAX_BYTES: usize = 32 * 1024 * 1024;

fn trim(history: &mut History) {
    let mut bytes: usize = history
        .undo
        .iter()
        .chain(&history.redo)
        .map(|entry| entry.bytes)
        .sum();
    while history.undo.len() + history.redo.len() > MAX_ENTRIES || bytes > MAX_BYTES {
        let entries = if history.undo.is_empty() {
            &mut history.redo
        } else {
            &mut history.undo
        };
        bytes -= entries.remove(0).bytes;
    }
}

impl Histories {
    pub fn register(&mut self, client: ClientId) {
        self.clients.entry(client).or_default();
    }
    pub fn retire(&mut self, client: ClientId) {
        self.clients.remove(&client);
    }

    fn entry(&mut self, action: Action) -> Arc<Entry> {
        self.next_entry = self
            .next_entry
            .checked_add(1)
            .expect("file history IDs exhausted");
        let bytes = action.retained_bytes() + std::mem::size_of::<Entry>();
        Arc::new(Entry {
            id: self.next_entry,
            action,
            bytes,
        })
    }

    pub fn push(
        &mut self,
        client: ClientId,
        action: Option<Action>,
        shared: bool,
    ) -> Result<(), String> {
        if !self.clients.contains_key(&client) {
            return Err("File history session is closed".into());
        }
        let entry = action.map(|action| self.entry(action));
        for (id, history) in &mut self.clients {
            if shared || *id == client {
                history.branch += 1;
                history.redo.clear();
                if let Some(entry) = &entry {
                    history.undo.push(entry.clone());
                }
                trim(history);
            }
        }
        self.revision += 1;
        Ok(())
    }

    pub fn clear(&mut self, client: ClientId) {
        if let Some(history) = self.clients.get_mut(&client) {
            history.generation += 1;
            history.branch += 1;
            history.undo.clear();
            history.redo.clear();
            self.revision += 1;
        }
    }

    pub fn summary(&self, client: ClientId) -> Summary {
        let history = self.clients.get(&client);
        Summary {
            revision: self.revision,
            undo_id: history
                .and_then(|history| history.undo.last())
                .map(|entry| entry.id),
            redo_id: history
                .and_then(|history| history.redo.last())
                .map(|entry| entry.id),
            stack_size: history.map_or(0, |history| history.undo.len()),
            busy: self.running.is_some(),
        }
    }

    pub fn begin(
        &mut self,
        client: ClientId,
        direction: Direction,
        expected: EntryId,
    ) -> Result<Reservation, String> {
        if self.running.is_some() {
            return Err("An undo or redo operation is already in progress".into());
        }
        let history = self
            .clients
            .get(&client)
            .ok_or("File history session is closed")?;
        let stack = match direction {
            Direction::Undo => &history.undo,
            Direction::Redo => &history.redo,
        };
        let entry = stack
            .last()
            .filter(|entry| entry.id == expected)
            .ok_or("File history changed before the operation could start")?;
        let tickets = self
            .clients
            .iter()
            .filter_map(|(client, history)| {
                let entries = match direction {
                    Direction::Undo => &history.undo,
                    Direction::Redo => &history.redo,
                };
                entries
                    .iter()
                    .any(|candidate| candidate.id == entry.id)
                    .then_some(Ticket {
                        client: *client,
                        generation: history.generation,
                        branch: history.branch,
                    })
            })
            .collect();
        let reservation = Reservation {
            id: entry.id,
            action: entry.action.clone(),
            direction,
            tickets,
        };
        self.running = Some(entry.id);
        self.revision += 1;
        Ok(reservation)
    }

    pub fn finish(&mut self, reservation: Reservation, result: &Execution) {
        if self.running != Some(reservation.id) {
            return;
        }
        let remaining = result.remaining.clone().map(|action| self.entry(action));
        let opposite = result.opposite.clone().map(|action| self.entry(action));
        for ticket in reservation.tickets {
            let Some(history) = self.clients.get_mut(&ticket.client) else {
                continue;
            };
            if history.generation != ticket.generation {
                continue;
            }
            let settle = |entries: &mut Vec<Arc<Entry>>| {
                *entries = entries
                    .iter()
                    .filter_map(|entry| {
                        if entry.id == reservation.id {
                            remaining.clone()
                        } else {
                            Some(entry.clone())
                        }
                    })
                    .collect();
            };
            match reservation.direction {
                Direction::Undo => {
                    settle(&mut history.undo);
                    if history.branch == ticket.branch {
                        if let Some(entry) = &opposite {
                            history.redo.push(entry.clone());
                        }
                    }
                }
                Direction::Redo => {
                    if history.branch == ticket.branch {
                        settle(&mut history.redo);
                    } else {
                        history.redo = remaining.iter().cloned().collect();
                    }
                    if let Some(entry) = &opposite {
                        history.undo.push(entry.clone());
                    }
                }
            }
            trim(history);
        }
        self.running = None;
        self.revision += 1;
    }
}

#[cfg(test)]
#[path = "../../test_support/file_history_model.rs"]
mod tests;
