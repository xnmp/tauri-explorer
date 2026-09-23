//! Compact IPC representation; filesystem/cache ownership keeps ordinary entries.
//! Columns avoid repeated JSON keys. A prefix is shared only when it reproduces
//! every native presentation path exactly, without frontend path normalization.
use super::{DirectoryListing, FileEntry};
use serde::{
    ser::{SerializeMap, SerializeSeq, SerializeStruct},
    Serialize, Serializer,
};

struct Column<'a, T> {
    entries: &'a [FileEntry],
    field: fn(&'a FileEntry) -> T,
}
impl<T: Serialize> Serialize for Column<'_, T> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut sequence = serializer.serialize_seq(Some(self.entries.len()))?;
        for entry in self.entries {
            sequence.serialize_element(&(self.field)(entry))?;
        }
        sequence.end()
    }
}

struct Columns<'a> {
    entries: &'a [FileEntry],
    prefix: Option<&'a str>,
}
impl Serialize for Columns<'_> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let entries = self.entries;
        let mut fields = serializer.serialize_map(None)?;
        fields.serialize_entry(
            "names",
            &Column {
                entries,
                field: |e| &e.name,
            },
        )?;
        if self.prefix.is_none() {
            fields.serialize_entry(
                "paths",
                &Column {
                    entries,
                    field: |e| &e.path,
                },
            )?;
        }
        fields.serialize_entry(
            "kinds",
            &Column {
                entries,
                field: |e| &e.kind,
            },
        )?;
        fields.serialize_entry(
            "sizes",
            &Column {
                entries,
                field: |e| e.size,
            },
        )?;
        fields.serialize_entry(
            "modified",
            &Column {
                entries,
                field: |e| &e.modified,
            },
        )?;
        if entries.iter().any(|e| e.is_symlink) {
            fields.serialize_entry(
                "is_symlink",
                &Column {
                    entries,
                    field: |e| e.is_symlink,
                },
            )?;
        }
        if entries.iter().any(|e| e.symlink_target.is_some()) {
            fields.serialize_entry(
                "symlink_target",
                &Column {
                    entries,
                    field: |e| &e.symlink_target,
                },
            )?;
        }
        if entries.iter().any(|e| e.is_empty.is_some()) {
            fields.serialize_entry(
                "is_empty",
                &Column {
                    entries,
                    field: |e| e.is_empty,
                },
            )?;
        }
        if entries.iter().any(|e| e.is_git_repo) {
            fields.serialize_entry(
                "is_git_repo",
                &Column {
                    entries,
                    field: |e| e.is_git_repo,
                },
            )?;
        }
        fields.end()
    }
}

impl Serialize for DirectoryListing {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let prefix = self
            .entries
            .first()
            .and_then(|entry| entry.path.strip_suffix(entry.name.as_str()))
            .filter(|prefix| {
                self.entries
                    .iter()
                    .all(|entry| entry.path.strip_prefix(prefix) == Some(entry.name.as_str()))
            });
        let mut result = serializer.serialize_struct("DirectoryListing", 4)?;
        result.serialize_field("format", "columns-v1")?;
        result.serialize_field("path", &self.path)?;
        result.serialize_field("path_prefix", &prefix)?;
        result.serialize_field(
            "columns",
            &Columns {
                entries: &self.entries,
                prefix,
            },
        )?;
        result.end()
    }
}

#[cfg(test)]
#[path = "../../test_support/directory_wire.rs"]
mod tests;
