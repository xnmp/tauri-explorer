"""File endpoints.

Issue: tauri-explorer-p1f, tauri-explorer-jql, tauri-explorer-bae, tauri-explorer-h3n, tauri-explorer-x25
"""

import platform
import subprocess
from pathlib import Path

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel

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