"""File listing endpoint.

Issue: tauri-explorer-p1f
"""

from pathlib import Path

from fastapi import APIRouter, HTTPException, Query

from domain.file_entry import list_directory

router = APIRouter()


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
