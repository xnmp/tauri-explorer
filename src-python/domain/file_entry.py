"""Domain layer for file entry operations.

Pure functions and immutable data structures with no external dependencies.
"""

from dataclasses import asdict, dataclass
from datetime import datetime
from pathlib import Path
from typing import Literal


@dataclass(frozen=True)
class FileEntry:
    """Immutable representation of a file system entry."""

    name: str
    path: str
    kind: Literal["file", "directory"]
    size: int  # bytes, 0 for directories
    modified: str  # ISO 8601 format


def list_directory(path: Path) -> list[dict]:
    """List directory contents as FileEntry dicts.

    Directories are sorted before files, and items are sorted
    case-insensitively by name within each group.

    Args:
        path: Directory path to list

    Returns:
        List of FileEntry dicts sorted by kind then name

    Raises:
        FileNotFoundError: If path doesn't exist or isn't a directory
    """
    if not path.exists() or not path.is_dir():
        raise FileNotFoundError(f"Not a directory: {path}")

    entries: list[FileEntry] = []

    for item in path.iterdir():
        try:
            stat = item.stat()
            entry = FileEntry(
                name=item.name,
                path=str(item.absolute()),
                kind="directory" if item.is_dir() else "file",
                size=0 if item.is_dir() else stat.st_size,
                modified=datetime.fromtimestamp(stat.st_mtime).isoformat(),
            )
            entries.append(entry)
        except (PermissionError, OSError):
            continue  # Skip inaccessible files

    # Sort: directories first, then by name case-insensitively
    sorted_entries = sorted(
        entries, key=lambda e: (e.kind != "directory", e.name.lower())
    )

    return [asdict(e) for e in sorted_entries]
