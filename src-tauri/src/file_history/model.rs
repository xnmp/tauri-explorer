//! File history policy. No runtime, window, IPC, or filesystem dependencies.
use crate::files::trash_artifact::TrashArtifact;
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, BTreeSet},
    sync::Arc,
};

pub type ClientId = u64;
pub type EntryId = u64;

/// Recovery belongs to its leaf, so sharing and retirement follow history.
/// Capture is the next trash operation; Restore contains its exact receipt.
#[derive(Clone, Debug, Default, PartialEq)]
pub enum Recovery<T> {
    #[default]
    Capture,
    Restore(T),
}

pub type RestoreArtifacts = BTreeMap<String, Arc<TrashArtifact>>;

// Conservative BTree node bound includes the sparsely occupied root and Arc
// allocation. Keep leaf accounting shared with the recovery retention fitter.
pub(super) const ARTIFACT_MAP_OVERHEAD: usize =
    std::mem::size_of::<RestoreArtifacts>() + 2 * std::mem::size_of::<usize>() + 1024;
pub(super) fn artifact_item_bytes(path: &String, artifact: &TrashArtifact) -> usize {
    path.capacity()
        + artifact.retained_bytes()
        + 3 * std::mem::size_of::<(String, Arc<TrashArtifact>)>()
        + 32
}

impl Recovery<Arc<RestoreArtifacts>> {
    pub fn subset(&self, paths: &[String]) -> Self {
        match self {
            Self::Capture => Self::Capture,
            Self::Restore(artifacts) => Self::Restore(Arc::new(
                paths
                    .iter()
                    .filter_map(|path| {
                        artifacts
                            .get(path)
                            .map(|artifact| (path.clone(), artifact.clone()))
                    })
                    .collect(),
            )),
        }
    }
}

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
        #[serde(skip)]
        recovery: Recovery<Arc<TrashArtifact>>,
    },
    Batch {
        actions: Vec<Action>,
        label: String,
    },
    Delete {
        paths: Vec<String>,
        parent_dir: String,
        #[serde(skip)]
        recovery: Recovery<Arc<RestoreArtifacts>>,
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
                    recovery,
                    ..
                } => {
                    copied_path.capacity()
                        + parent_dir.capacity()
                        + match recovery {
                            Recovery::Capture => 0,
                            Recovery::Restore(artifact) => artifact.retained_bytes(),
                        }
                }
                Self::Delete {
                    paths,
                    parent_dir,
                    recovery,
                } => {
                    parent_dir.capacity()
                        + paths.capacity() * std::mem::size_of::<String>()
                        + paths.iter().map(String::capacity).sum::<usize>()
                        + match recovery {
                            Recovery::Capture => 0,
                            // Conservatively account map nodes as well as the
                            // keys and shared artifact allocations they retain.
                            Recovery::Restore(artifacts) => {
                                ARTIFACT_MAP_OVERHEAD
                                    + artifacts
                                        .iter()
                                        .map(|(path, artifact)| artifact_item_bytes(path, artifact))
                                        .sum::<usize>()
                            }
                        }
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
    /// Auxiliary filesystem effects do not imply a completed history action.
    pub refresh_dirs: Vec<String>,
    pub completed: Option<Action>,
    pub uncertain: Option<Action>,
    pub opposite: Option<Action>,
    pub remaining: Option<Action>,
    pub error: Option<String>,
}

#[derive(Clone, Debug)]
struct Entry {
    id: EntryId,
    action: Action,
    bytes: usize,
    // Partial settlement has a fresh executable ID but retains the admission
    // whose unfinished work it represents for overlapping forward operations.
    continuation_of: Option<EntryId>,
}

#[derive(Clone, Copy, Debug, PartialEq)]
enum PendingKind {
    Forward,
    Opposite,
}

/// Active positions are separate from retained, executable history. A reserved
/// source keeps its identity until settlement; a pending position has no action.
#[derive(Clone, Debug)]
enum Slot {
    Ready(Arc<Entry>),
    Reserved(Arc<Entry>),
    Pending { id: EntryId, kind: PendingKind },
}
impl Slot {
    fn id(&self) -> EntryId {
        match self {
            Self::Ready(entry) | Self::Reserved(entry) => entry.id,
            Self::Pending { id, .. } => *id,
        }
    }
    fn ready(&self) -> Option<&Arc<Entry>> {
        match self {
            Self::Ready(entry) => Some(entry),
            _ => None,
        }
    }
    fn pending_forward(&self) -> bool {
        matches!(
            self,
            Self::Pending {
                kind: PendingKind::Forward,
                ..
            }
        )
    }
}

#[derive(Default)]
struct History {
    undo: Vec<Slot>,
    redo: Vec<Slot>,
    generation: u64,
    branch: u64,
}
impl History {
    fn invalidate_redo(&mut self, overlapping_redo: Option<EntryId>) {
        // A Redo already admitted must still settle its source/remaining work.
        // A pending Undo opposite is invalidated by a newer committed forward.
        self.redo.retain(|slot| match slot {
            Slot::Reserved(_) => true,
            Slot::Ready(entry) => {
                overlapping_redo.is_some() && entry.continuation_of == overlapping_redo
            }
            Slot::Pending { .. } => false,
        });
        self.branch += 1;
    }
    fn forward_pending(&self) -> bool {
        self.undo.iter().any(Slot::pending_forward)
    }
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
    opposite_id: EntryId,
}

#[derive(Clone, Debug)]
pub struct ForwardReservation {
    id: EntryId,
    tickets: Vec<ForwardTicket>,
}

#[derive(Clone, Debug)]
struct ForwardTicket {
    client: ClientId,
    generation: u64,
    overlapping_redo: Option<EntryId>,
}

impl ForwardReservation {
    #[cfg(feature = "e2e-renderer-recovery")]
    pub(super) fn id(&self) -> EntryId {
        self.id
    }
}

/// History projection of a forward outcome. Confirmed or uncertain effects
/// supersede Redo; only confirmed recoverable effects may supply an inverse.
pub enum ForwardEffect {
    Unchanged,
    Changed(Option<Action>),
}

/// One application authority, with independent window histories and explicitly
/// shared transfer entries. Active work owns positions across caller teardown.
#[derive(Default)]
pub struct Histories {
    clients: BTreeMap<ClientId, History>,
    next_entry: EntryId,
    revision: u64,
    running: Option<EntryId>,
    forwards: BTreeSet<EntryId>,
}

const MAX_ENTRIES: usize = 256;
pub(super) const MAX_BYTES: usize = 32 * 1024 * 1024;
pub(super) const ENTRY_OVERHEAD: usize =
    std::mem::size_of::<Entry>() + 2 * std::mem::size_of::<usize>() + std::mem::size_of::<Slot>();

pub(super) fn entry_bytes(action: &Action) -> usize {
    action.retained_bytes() + ENTRY_OVERHEAD
}
const MAX_PENDING_FORWARDS: usize = 128;

fn replace_slot(entries: &mut Vec<Slot>, id: EntryId, replacement: Option<&Slot>) {
    *entries = entries
        .iter()
        .filter_map(|slot| {
            if slot.id() == id {
                replacement.cloned()
            } else {
                Some(slot.clone())
            }
        })
        .collect();
}

fn trim(history: &mut History) {
    let ready = || {
        history
            .undo
            .iter()
            .chain(&history.redo)
            .filter_map(Slot::ready)
    };
    let mut count = ready().count();
    let mut bytes: usize = ready().map(|entry| entry.bytes).sum();
    while count > MAX_ENTRIES || bytes > MAX_BYTES {
        // Temporary active slots are separately bounded, never evicted. Across
        // both stacks discard the oldest ready identity, not a newly settled
        // undo opposite merely because the older entries happen to be in redo.
        let candidate =
            history
                .undo
                .iter()
                .enumerate()
                .filter_map(|(index, slot)| slot.ready().map(|entry| (entry.id, true, index)))
                .chain(
                    history.redo.iter().enumerate().filter_map(|(index, slot)| {
                        slot.ready().map(|entry| (entry.id, false, index))
                    }),
                )
                .min_by_key(|(id, _, _)| *id);
        let Some((_, undo, index)) = candidate else {
            break;
        };
        let slots = if undo {
            &mut history.undo
        } else {
            &mut history.redo
        };
        if let Slot::Ready(entry) = slots.remove(index) {
            bytes -= entry.bytes;
            count -= 1;
        }
    }
}

impl Histories {
    pub fn register(&mut self, client: ClientId) {
        self.clients.entry(client).or_default();
    }
    pub fn retire(&mut self, client: ClientId) {
        self.clients.remove(&client);
    }

    fn next_id(&mut self) -> EntryId {
        self.next_entry = self
            .next_entry
            .checked_add(1)
            .expect("file history IDs exhausted");
        self.next_entry
    }
    fn ready(id: EntryId, action: Action, continuation_of: Option<EntryId>) -> Slot {
        let bytes = entry_bytes(&action);
        Slot::Ready(Arc::new(Entry {
            id,
            action,
            bytes,
            continuation_of,
        }))
    }
    fn entry(&mut self, action: Action) -> Slot {
        Self::ready(self.next_id(), action, None)
    }

    pub fn begin_forward(
        &mut self,
        client: ClientId,
        shared: bool,
    ) -> Result<ForwardReservation, String> {
        if !self.clients.contains_key(&client) {
            return Err("File history session is closed".into());
        }
        // A global cap also bounds every captured participant atomically.
        if self.forwards.len() >= MAX_PENDING_FORWARDS {
            return Err("Too many file operations are in progress".into());
        }
        let id = self.next_id();
        let mut tickets = Vec::new();
        for (participant, history) in &mut self.clients {
            if shared || *participant == client {
                tickets.push(ForwardTicket {
                    client: *participant,
                    generation: history.generation,
                    overlapping_redo: history.redo.iter().find_map(|slot| match slot {
                        Slot::Reserved(entry) => Some(entry.id),
                        _ => None,
                    }),
                });
                history.undo.push(Slot::Pending {
                    id,
                    kind: PendingKind::Forward,
                });
            }
        }
        self.forwards.insert(id);
        self.revision += 1;
        Ok(ForwardReservation { id, tickets })
    }

    pub fn finish_forward(&mut self, reservation: ForwardReservation, effect: ForwardEffect) {
        if !self.forwards.remove(&reservation.id) {
            return;
        }
        let changed = !matches!(&effect, ForwardEffect::Unchanged);
        let replacement = match effect {
            ForwardEffect::Changed(Some(action)) => Some(Self::ready(reservation.id, action, None)),
            _ => None,
        };
        for ticket in reservation.tickets {
            let Some(history) = self.clients.get_mut(&ticket.client) else {
                continue;
            };
            if history.generation != ticket.generation
                || !history
                    .undo
                    .iter()
                    .any(|slot| slot.id() == reservation.id && slot.pending_forward())
            {
                continue;
            }
            replace_slot(&mut history.undo, reservation.id, replacement.as_ref());
            if changed {
                history.invalidate_redo(ticket.overlapping_redo);
            }
            trim(history);
        }
        self.revision += 1;
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
                history.invalidate_redo(None);
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

    fn forward_blocks(&self, entry_id: EntryId, direction: Direction) -> bool {
        if self.forwards.is_empty() {
            return false;
        }
        self.clients
            .values()
            .filter(|history| history.forward_pending())
            .any(|history| {
                let entries = match direction {
                    Direction::Undo => &history.undo,
                    Direction::Redo => &history.redo,
                };
                entries.iter().any(|slot| slot.id() == entry_id)
            })
    }

    pub fn summary(&self, client: ClientId) -> Summary {
        let history = self.clients.get(&client);
        Summary {
            revision: self.revision,
            undo_id: history
                .and_then(|history| history.undo.last())
                .and_then(Slot::ready)
                .map(|entry| entry.id),
            redo_id: history
                .and_then(|history| history.redo.last())
                .and_then(Slot::ready)
                .map(|entry| entry.id),
            stack_size: history.map_or(0, |history| {
                history
                    .undo
                    .iter()
                    .filter(|slot| !matches!(slot, Slot::Pending { .. }))
                    .count()
            }),
            busy: self.running.is_some()
                || history.is_some_and(|history| {
                    history.forward_pending()
                        || [
                            (Direction::Undo, &history.undo),
                            (Direction::Redo, &history.redo),
                        ]
                        .into_iter()
                        .any(|(direction, entries)| {
                            entries
                                .last()
                                .and_then(Slot::ready)
                                .is_some_and(|entry| self.forward_blocks(entry.id, direction))
                        })
                }),
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
            .and_then(Slot::ready)
            .filter(|entry| entry.id == expected)
            .cloned()
            .ok_or("File history changed before the operation could start")?;
        let tickets: Vec<_> = self
            .clients
            .iter()
            .filter_map(|(client, history)| {
                let entries = match direction {
                    Direction::Undo => &history.undo,
                    Direction::Redo => &history.redo,
                };
                entries
                    .iter()
                    .any(|slot| slot.id() == entry.id)
                    .then_some(Ticket {
                        client: *client,
                        generation: history.generation,
                        branch: history.branch,
                    })
            })
            .collect();
        if self.forward_blocks(entry.id, direction) {
            return Err("File operations are still in progress".into());
        }
        let opposite_id = self.next_id();
        let opposite = Slot::Pending {
            id: opposite_id,
            kind: PendingKind::Opposite,
        };
        for ticket in &tickets {
            let history = self.clients.get_mut(&ticket.client).unwrap();
            let (source, target) = match direction {
                Direction::Undo => (&mut history.undo, &mut history.redo),
                Direction::Redo => (&mut history.redo, &mut history.undo),
            };
            replace_slot(source, entry.id, Some(&Slot::Reserved(entry.clone())));
            target.push(opposite.clone());
        }
        let reservation = Reservation {
            id: entry.id,
            action: entry.action.clone(),
            direction,
            tickets,
            opposite_id,
        };
        self.running = Some(entry.id);
        self.revision += 1;
        Ok(reservation)
    }

    pub fn finish(&mut self, reservation: Reservation, result: &Execution) {
        if self.running != Some(reservation.id) {
            return;
        }
        debug_assert!(
            result
                .remaining
                .iter()
                .chain(&result.opposite)
                .map(entry_bytes)
                .sum::<usize>()
                <= MAX_BYTES
        );
        // A partial result is new work with a fresh ID: a stale original request
        // must never be able to execute the remaining subset automatically.
        let remaining = result
            .remaining
            .clone()
            .map(|action| Self::ready(self.next_id(), action, Some(reservation.id)));
        let opposite = result
            .opposite
            .clone()
            .map(|action| Self::ready(reservation.opposite_id, action, None));
        for ticket in reservation.tickets {
            let Some(history) = self.clients.get_mut(&ticket.client) else {
                continue;
            };
            if history.generation != ticket.generation {
                continue;
            }
            let source = match reservation.direction {
                Direction::Undo => &history.undo,
                Direction::Redo => &history.redo,
            };
            if !source
                .iter()
                .any(|slot| matches!(slot, Slot::Reserved(entry) if entry.id == reservation.id))
            {
                continue;
            }
            match reservation.direction {
                Direction::Undo => {
                    replace_slot(&mut history.undo, reservation.id, remaining.as_ref());
                    let opposite = if history.branch == ticket.branch {
                        opposite.as_ref()
                    } else {
                        None
                    };
                    replace_slot(&mut history.redo, reservation.opposite_id, opposite);
                }
                Direction::Redo => {
                    replace_slot(&mut history.redo, reservation.id, remaining.as_ref());
                    replace_slot(
                        &mut history.undo,
                        reservation.opposite_id,
                        opposite.as_ref(),
                    );
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
