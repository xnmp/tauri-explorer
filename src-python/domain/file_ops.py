"""Domain layer for file operations (write operations).

Pure functions with no external dependencies beyond stdlib.
Issue: tauri-explorer-jql, tauri-explorer-bae, tauri-explorer-h3n, tauri-explorer-x25
"""

import shutil
from dataclasses import asdict
from datetime import datetime
from pathlib import Path
from typing import Literal

from .file_entry import FileEntry


def create_directory(path: Path) -> dict:
    """Create a new directory and return its FileEntry.

    Args:
        path: Absolute path for the new directory

    Returns:
        FileEntry dict for the created directory

    Raises:
        FileExistsError: If path already exists
        FileNotFoundError: If parent directory doesn't exist
        ValueError: If path name is empty/invalid
    """
    if not path.name:
        raise ValueError("Directory name cannot be empty")

    if path.exists():
        raise FileExistsError(f"Path already exists: {path}")

    if not path.parent.exists():
        raise FileNotFoundError(f"Parent directory does not exist: {path.parent}")

    path.mkdir()

    stat = path.stat()
    entry = FileEntry(
        name=path.name,
        path=str(path.absolute()),
        kind="directory",
        size=0,
        modified=datetime.fromtimestamp(stat.st_mtime).isoformat(),
    )

    return asdict(entry)


def rename_entry(source: Path, new_name: str) -> dict:
    """Rename a file or directory.

    Issue: tauri-explorer-bae

    Args:
        source: Path to the file/directory to rename
        new_name: New name for the entry (just the name, not full path)

    Returns:
        FileEntry dict for the renamed entry

    Raises:
        FileNotFoundError: If source doesn't exist
        FileExistsError: If target already exists
        ValueError: If new_name is empty
    """
    if not new_name:
        raise ValueError("New name cannot be empty")

    if not source.exists():
        raise FileNotFoundError(f"Source does not exist: {source}")

    target = source.parent / new_name

    if target.exists():
        raise FileExistsError(f"Target already exists: {target}")

    source.rename(target)

    stat = target.stat()
    kind: Literal["file", "directory"] = "directory" if target.is_dir() else "file"
    entry = FileEntry(
        name=target.name,
        path=str(target.absolute()),
        kind=kind,
        size=0 if target.is_dir() else stat.st_size,
        modified=datetime.fromtimestamp(stat.st_mtime).isoformat(),
    )

    return asdict(entry)


def delete_entry(path: Path) -> None:
    """Delete a file or directory.

    Issue: tauri-explorer-h3n

    Args:
        path: Path to the file/directory to delete

    Raises:
        FileNotFoundError: If path doesn't exist
    """
    if not path.exists():
        raise FileNotFoundError(f"Path does not exist: {path}")

    if path.is_dir():
        shutil.rmtree(path)
    else:
        path.unlink()


def _generate_copy_name(dest_dir: Path, source_name: str, is_directory: bool) -> Path:
    """Generate a unique copy name like 'name - Copy.ext' or 'name - Copy (2).ext'.

    Args:
        dest_dir: Destination directory
        source_name: Original file/directory name
        is_directory: Whether the source is a directory

    Returns:
        Path with unique name that doesn't exist
    """
    if is_directory:
        base_name = source_name
        extension = ""
    else:
        # Split name and extension
        if "." in source_name:
            parts = source_name.rsplit(".", 1)
            base_name = parts[0]
            extension = f".{parts[1]}"
        else:
            base_name = source_name
            extension = ""

    # Try "name - Copy.ext" first
    copy_name = f"{base_name} - Copy{extension}"
    target = dest_dir / copy_name
    if not target.exists():
        return target

    # Try "name - Copy (n).ext" for n = 2, 3, 4, ...
    counter = 2
    while True:
        copy_name = f"{base_name} - Copy ({counter}){extension}"
        target = dest_dir / copy_name
        if not target.exists():
            return target
        counter += 1
        if counter > 1000:  # Safety limit
            raise FileExistsError("Too many copies exist")


def copy_entry(source: Path, dest_dir: Path) -> dict:
    """Copy a file or directory to a destination directory.

    If copying to the same directory where source exists, creates a copy
    with name like 'file - Copy.ext' (Windows Explorer behavior).

    Issue: tauri-explorer-x25

    Args:
        source: Path to the file/directory to copy
        dest_dir: Destination directory (target will have same name as source)

    Returns:
        FileEntry dict for the copied entry

    Raises:
        FileNotFoundError: If source or dest_dir doesn't exist
    """
    if not source.exists():
        raise FileNotFoundError(f"Source does not exist: {source}")

    if not dest_dir.exists():
        raise FileNotFoundError(f"Destination directory does not exist: {dest_dir}")

    target = dest_dir / source.name

    # If target exists, generate a "name - Copy" style name
    if target.exists():
        target = _generate_copy_name(dest_dir, source.name, source.is_dir())

    if source.is_dir():
        shutil.copytree(source, target)
    else:
        shutil.copy2(source, target)

    stat = target.stat()
    kind: Literal["file", "directory"] = "directory" if target.is_dir() else "file"
    entry = FileEntry(
        name=target.name,
        path=str(target.absolute()),
        kind=kind,
        size=0 if target.is_dir() else stat.st_size,
        modified=datetime.fromtimestamp(stat.st_mtime).isoformat(),
    )

    return asdict(entry)


def move_entry(source: Path, dest_dir: Path) -> dict:
    """Move a file or directory to a destination directory.

    Issue: tauri-explorer-x25

    Args:
        source: Path to the file/directory to move
        dest_dir: Destination directory (target will have same name as source)

    Returns:
        FileEntry dict for the moved entry

    Raises:
        FileNotFoundError: If source or dest_dir doesn't exist
        FileExistsError: If target already exists
    """
    if not source.exists():
        raise FileNotFoundError(f"Source does not exist: {source}")

    if not dest_dir.exists():
        raise FileNotFoundError(f"Destination directory does not exist: {dest_dir}")

    target = dest_dir / source.name

    if target.exists():
        raise FileExistsError(f"Target already exists: {target}")

    shutil.move(str(source), str(target))

    stat = target.stat()
    kind: Literal["file", "directory"] = "directory" if target.is_dir() else "file"
    entry = FileEntry(
        name=target.name,
        path=str(target.absolute()),
        kind=kind,
        size=0 if target.is_dir() else stat.st_size,
        modified=datetime.fromtimestamp(stat.st_mtime).isoformat(),
    )

    return asdict(entry)
