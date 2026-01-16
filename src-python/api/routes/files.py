"""File endpoints.

Issue: tauri-explorer-p1f, tauri-explorer-jql, tauri-explorer-bae, tauri-explorer-h3n, tauri-explorer-x25
Issue: tauri-explorer-w3t (fuzzy search)
"""

import os
import platform
import subprocess
from pathlib import Path
from typing import Iterator

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel
from rapidfuzz import fuzz, process

from domain.file_entry import list_directory
from domain.file_ops import create_directory, delete_entry, rename_entry, copy_entry, move_entry

router = APIRouter()


class MkdirRequest(BaseModel):
    """Request body for mkdir endpoint."""

    path: str  # Parent directory
    name: str  # New folder name


class RenameRequest(BaseModel):
    """Request body for rename endpoint."""

    path: str  # Full path to file/directory
    new_name: str  # New name (just the name, not full path)


class CopyRequest(BaseModel):
    """Request body for copy endpoint."""

    source: str  # Full path to source file/directory
    dest_dir: str  # Destination directory


class MoveRequest(BaseModel):
    """Request body for move endpoint."""

    source: str  # Full path to source file/directory
    dest_dir: str  # Destination directory


class OpenRequest(BaseModel):
    """Request body for open endpoint."""

    path: str  # Full path to file to open


@router.get("/home")
def get_home_directory():
    """Get the user's home directory path.

    Returns:
        JSON with the home directory path
    """
    import os
    home = os.path.expanduser("~")
    return {"path": home}


@router.get("/list")
def list_files(path: str = Query(..., description="Directory path")):
    """List files in a directory.

    Args:
        path: Absolute path to directory

    Returns:
        DirectoryListing with path and entries
    """
    try:
        entries = list_directory(Path(path))
        return {"path": path, "entries": entries}
    except FileNotFoundError:
        raise HTTPException(404, "Directory not found")
    except PermissionError:
        raise HTTPException(403, "Permission denied")


@router.post("/mkdir", status_code=201)
def mkdir(request: MkdirRequest):
    """Create a new directory.

    Issue: tauri-explorer-jql

    Args:
        request: MkdirRequest with path and name

    Returns:
        FileEntry for the created directory
    """
    try:
        new_path = Path(request.path) / request.name
        entry = create_directory(new_path)
        return JSONResponse(content=entry, status_code=201)
    except FileNotFoundError:
        raise HTTPException(404, "Parent directory not found")
    except FileExistsError:
        raise HTTPException(409, "Directory already exists")
    except PermissionError:
        raise HTTPException(403, "Permission denied")


@router.post("/rename")
def rename(request: RenameRequest):
    """Rename a file or directory.

    Issue: tauri-explorer-bae

    Args:
        request: RenameRequest with path and new_name

    Returns:
        FileEntry for the renamed entry
    """
    try:
        entry = rename_entry(Path(request.path), request.new_name)
        return entry
    except FileNotFoundError:
        raise HTTPException(404, "File or directory not found")
    except FileExistsError:
        raise HTTPException(409, "Target already exists")
    except ValueError as e:
        raise HTTPException(400, str(e))
    except PermissionError:
        raise HTTPException(403, "Permission denied")


@router.delete("/delete", status_code=204)
def delete(path: str = Query(..., description="Path to file or directory")):
    """Delete a file or directory.

    Issue: tauri-explorer-h3n

    Args:
        path: Absolute path to file or directory to delete

    Returns:
        204 No Content on success
    """
    try:
        delete_entry(Path(path))
        return Response(status_code=204)
    except FileNotFoundError:
        raise HTTPException(404, "File or directory not found")
    except PermissionError:
        raise HTTPException(403, "Permission denied")


@router.post("/copy", status_code=201)
def copy(request: CopyRequest):
    """Copy a file or directory.

    Issue: tauri-explorer-x25

    Args:
        request: CopyRequest with source and dest_dir

    Returns:
        FileEntry for the copied entry
    """
    try:
        entry = copy_entry(Path(request.source), Path(request.dest_dir))
        return JSONResponse(content=entry, status_code=201)
    except FileNotFoundError:
        raise HTTPException(404, "Source or destination not found")
    except FileExistsError:
        raise HTTPException(409, "Target already exists")
    except PermissionError:
        raise HTTPException(403, "Permission denied")


@router.post("/move")
def move(request: MoveRequest):
    """Move a file or directory.

    Issue: tauri-explorer-x25

    Args:
        request: MoveRequest with source and dest_dir

    Returns:
        FileEntry for the moved entry
    """
    try:
        entry = move_entry(Path(request.source), Path(request.dest_dir))
        return entry
    except FileNotFoundError:
        raise HTTPException(404, "Source or destination not found")
    except FileExistsError:
        raise HTTPException(409, "Target already exists")
    except PermissionError:
        raise HTTPException(403, "Permission denied")


@router.post("/open")
def open_file(request: OpenRequest):
    """Open a file in the system's default application.

    Args:
        request: OpenRequest with path

    Returns:
        Success message
    """
    path = Path(request.path)
    if not path.exists():
        raise HTTPException(404, "File not found")

    try:
        system = platform.system()
        if system == "Windows":
            # Use os.startfile on Windows
            import os
            os.startfile(str(path))
        elif system == "Darwin":
            # macOS
            subprocess.Popen(["open", str(path)])
        else:
            # Linux and other Unix-like systems
            subprocess.Popen(["xdg-open", str(path)])
        return {"success": True, "path": str(path)}
    except Exception as e:
        raise HTTPException(500, f"Failed to open file: {str(e)}")


# Directories to skip during recursive search (for performance)
SKIP_DIRS = {
    ".git", ".svn", ".hg",
    "node_modules", "__pycache__", ".venv", "venv",
    ".cache", ".npm", ".cargo",
    "target", "build", "dist", "out",
    ".idea", ".vscode",
}


def walk_files(root: Path, max_files: int = 10000) -> Iterator[str]:
    """Recursively walk directory yielding relative file paths.

    Skips common non-user directories for performance.
    """
    count = 0
    for dirpath, dirnames, filenames in os.walk(root):
        # Filter out directories we want to skip (modifies in-place)
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS and not d.startswith(".")]

        rel_dir = Path(dirpath).relative_to(root)

        for filename in filenames:
            if filename.startswith("."):
                continue
            if count >= max_files:
                return
            rel_path = str(rel_dir / filename) if str(rel_dir) != "." else filename
            yield rel_path
            count += 1


def walk_entries(root: Path, max_entries: int = 10000) -> Iterator[tuple[str, str]]:
    """Recursively walk directory yielding (relative_path, kind) tuples.

    Returns both files and directories. Skips common non-user directories.
    """
    count = 0
    for dirpath, dirnames, filenames in os.walk(root):
        # Filter out directories we want to skip (modifies in-place)
        visible_dirs = [d for d in dirnames if d not in SKIP_DIRS and not d.startswith(".")]
        dirnames[:] = visible_dirs

        rel_dir = Path(dirpath).relative_to(root)

        # Yield directories first
        for dirname in visible_dirs:
            if count >= max_entries:
                return
            rel_path = str(rel_dir / dirname) if str(rel_dir) != "." else dirname
            yield (rel_path, "directory")
            count += 1

        # Then yield files
        for filename in filenames:
            if filename.startswith("."):
                continue
            if count >= max_entries:
                return
            rel_path = str(rel_dir / filename) if str(rel_dir) != "." else filename
            yield (rel_path, "file")
            count += 1


@router.get("/search")
def fuzzy_search(
    query: str = Query(..., description="Search query", min_length=1),
    root: str = Query(..., description="Root directory to search"),
    limit: int = Query(20, description="Max results to return", ge=1, le=100),
):
    """Fuzzy search for files and folders recursively in a directory.

    Issue: tauri-explorer-w3t, tauri-explorer-rxx, tauri-explorer-459h

    Uses rapidfuzz for fast fuzzy matching. Returns entries sorted by match score.
    Includes both files and directories in results.

    Args:
        query: The search query (fuzzy matched against file/folder names)
        root: Root directory to search in
        limit: Maximum number of results to return

    Returns:
        List of matching entries with scores, paths, and kind (file/directory)
    """
    root_path = Path(root)
    if not root_path.exists():
        raise HTTPException(404, "Directory not found")
    if not root_path.is_dir():
        raise HTTPException(400, "Path is not a directory")

    # Collect all entries (files and directories)
    entries = list(walk_entries(root_path))

    if not entries:
        return {"results": []}

    # Extract just the relative paths and kinds
    rel_paths = [e[0] for e in entries]
    kinds = [e[1] for e in entries]

    # Use rapidfuzz to find best matches
    # We match against just the name for better UX, but return full relative path
    entry_names = [Path(p).name for p in rel_paths]

    # Use partial ratio for substring matching (like fzf)
    matches = process.extract(
        query,
        entry_names,
        scorer=fuzz.partial_ratio,
        limit=limit,
        score_cutoff=40,  # Minimum score threshold
    )

    results = []
    for match_name, score, idx in matches:
        rel_path = rel_paths[idx]
        full_path = str(root_path / rel_path)
        kind = kinds[idx]
        results.append({
            "name": match_name,
            "path": full_path,
            "relativePath": rel_path,
            "score": score,
            "kind": kind,
        })

    return {"results": results}