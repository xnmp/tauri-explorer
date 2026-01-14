"""Tests for FastAPI endpoints.

Issue: tauri-explorer-p1f, tauri-explorer-x25
"""

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from api.main import app

client = TestClient(app)


class TestHealth:
    """Tests for /health endpoint."""

    def test_health_returns_ok(self):
        response = client.get("/health")
        assert response.status_code == 200
        assert response.json() == {"status": "ok"}


class TestListFiles:
    """Tests for /api/files/list endpoint."""

    def test_list_files_valid_path(self, tmp_path: Path):
        (tmp_path / "test.txt").write_text("content")

        response = client.get(f"/api/files/list?path={tmp_path}")

        assert response.status_code == 200
        data = response.json()
        assert data["path"] == str(tmp_path)
        assert len(data["entries"]) == 1
        assert data["entries"][0]["name"] == "test.txt"

    def test_list_files_empty_directory(self, tmp_path: Path):
        response = client.get(f"/api/files/list?path={tmp_path}")

        assert response.status_code == 200
        data = response.json()
        assert data["entries"] == []

    def test_list_files_not_found(self):
        response = client.get("/api/files/list?path=/nonexistent/path/12345")

        assert response.status_code == 404
        assert "not found" in response.json()["detail"].lower()

    def test_list_files_missing_param(self):
        response = client.get("/api/files/list")

        assert response.status_code == 422

    def test_list_files_returns_correct_structure(self, tmp_path: Path):
        (tmp_path / "file.txt").write_text("content")
        (tmp_path / "subdir").mkdir()

        response = client.get(f"/api/files/list?path={tmp_path}")

        data = response.json()
        assert "path" in data
        assert "entries" in data

        # Check entry structure
        for entry in data["entries"]:
            assert "name" in entry
            assert "path" in entry
            assert "kind" in entry
            assert "size" in entry
            assert "modified" in entry

    def test_list_files_directories_first(self, tmp_path: Path):
        (tmp_path / "z_file.txt").touch()
        (tmp_path / "a_dir").mkdir()

        response = client.get(f"/api/files/list?path={tmp_path}")

        entries = response.json()["entries"]
        assert entries[0]["kind"] == "directory"
        assert entries[1]["kind"] == "file"


class TestMkdir:
    """Tests for /api/files/mkdir endpoint.

    Issue: tauri-explorer-jql
    """

    def test_mkdir_success(self, tmp_path: Path):
        new_dir = tmp_path / "new_folder"

        response = client.post(
            "/api/files/mkdir",
            json={"path": str(tmp_path), "name": "new_folder"},
        )

        assert response.status_code == 201
        assert new_dir.exists()
        data = response.json()
        assert data["name"] == "new_folder"
        assert data["kind"] == "directory"

    def test_mkdir_already_exists(self, tmp_path: Path):
        existing = tmp_path / "existing"
        existing.mkdir()

        response = client.post(
            "/api/files/mkdir",
            json={"path": str(tmp_path), "name": "existing"},
        )

        assert response.status_code == 409

    def test_mkdir_parent_not_found(self):
        response = client.post(
            "/api/files/mkdir",
            json={"path": "/nonexistent/path", "name": "folder"},
        )

        assert response.status_code == 404

    def test_mkdir_missing_name(self, tmp_path: Path):
        response = client.post(
            "/api/files/mkdir",
            json={"path": str(tmp_path)},
        )

        assert response.status_code == 422


class TestRename:
    """Tests for /api/files/rename endpoint.

    Issue: tauri-explorer-bae
    """

    def test_rename_file_success(self, tmp_path: Path):
        old_file = tmp_path / "old.txt"
        old_file.write_text("content")

        response = client.post(
            "/api/files/rename",
            json={"path": str(old_file), "new_name": "new.txt"},
        )

        assert response.status_code == 200
        assert not old_file.exists()
        assert (tmp_path / "new.txt").exists()
        data = response.json()
        assert data["name"] == "new.txt"

    def test_rename_source_not_found(self, tmp_path: Path):
        response = client.post(
            "/api/files/rename",
            json={"path": str(tmp_path / "nonexistent.txt"), "new_name": "new.txt"},
        )

        assert response.status_code == 404

    def test_rename_target_exists(self, tmp_path: Path):
        (tmp_path / "existing.txt").touch()
        source = tmp_path / "source.txt"
        source.touch()

        response = client.post(
            "/api/files/rename",
            json={"path": str(source), "new_name": "existing.txt"},
        )

        assert response.status_code == 409


class TestDelete:
    """Tests for /api/files/delete endpoint.

    Issue: tauri-explorer-h3n
    """

    def test_delete_file_success(self, tmp_path: Path):
        file = tmp_path / "file.txt"
        file.write_text("content")

        response = client.delete(f"/api/files/delete?path={file}")

        assert response.status_code == 204
        assert not file.exists()

    def test_delete_directory_success(self, tmp_path: Path):
        dir = tmp_path / "dir"
        dir.mkdir()
        (dir / "file.txt").touch()

        response = client.delete(f"/api/files/delete?path={dir}")

        assert response.status_code == 204
        assert not dir.exists()

    def test_delete_not_found(self, tmp_path: Path):
        response = client.delete(f"/api/files/delete?path={tmp_path}/nonexistent.txt")

        assert response.status_code == 404


class TestCopy:
    """Tests for /api/files/copy endpoint.

    Issue: tauri-explorer-x25
    """

    def test_copy_file_success(self, tmp_path: Path):
        source = tmp_path / "source.txt"
        source.write_text("content")
        dest_dir = tmp_path / "dest"
        dest_dir.mkdir()

        response = client.post(
            "/api/files/copy",
            json={"source": str(source), "dest_dir": str(dest_dir)},
        )

        assert response.status_code == 201
        assert source.exists()  # Source should remain
        assert (dest_dir / "source.txt").exists()
        data = response.json()
        assert data["name"] == "source.txt"

    def test_copy_source_not_found(self, tmp_path: Path):
        dest_dir = tmp_path / "dest"
        dest_dir.mkdir()

        response = client.post(
            "/api/files/copy",
            json={"source": str(tmp_path / "nonexistent.txt"), "dest_dir": str(dest_dir)},
        )

        assert response.status_code == 404

    def test_copy_target_exists_creates_copy_name(self, tmp_path: Path):
        """When target exists, creates 'name - Copy.ext' instead of error."""
        source = tmp_path / "source.txt"
        source.write_text("content")
        dest_dir = tmp_path / "dest"
        dest_dir.mkdir()
        (dest_dir / "source.txt").touch()

        response = client.post(
            "/api/files/copy",
            json={"source": str(source), "dest_dir": str(dest_dir)},
        )

        assert response.status_code == 201
        data = response.json()
        assert data["name"] == "source - Copy.txt"
        assert (dest_dir / "source - Copy.txt").exists()


class TestMove:
    """Tests for /api/files/move endpoint.

    Issue: tauri-explorer-x25
    """

    def test_move_file_success(self, tmp_path: Path):
        source = tmp_path / "source.txt"
        source.write_text("content")
        dest_dir = tmp_path / "dest"
        dest_dir.mkdir()

        response = client.post(
            "/api/files/move",
            json={"source": str(source), "dest_dir": str(dest_dir)},
        )

        assert response.status_code == 200
        assert not source.exists()  # Source should be gone
        assert (dest_dir / "source.txt").exists()
        data = response.json()
        assert data["name"] == "source.txt"

    def test_move_source_not_found(self, tmp_path: Path):
        dest_dir = tmp_path / "dest"
        dest_dir.mkdir()

        response = client.post(
            "/api/files/move",
            json={"source": str(tmp_path / "nonexistent.txt"), "dest_dir": str(dest_dir)},
        )

        assert response.status_code == 404

    def test_move_target_exists(self, tmp_path: Path):
        source = tmp_path / "source.txt"
        source.write_text("content")
        dest_dir = tmp_path / "dest"
        dest_dir.mkdir()
        (dest_dir / "source.txt").touch()

        response = client.post(
            "/api/files/move",
            json={"source": str(source), "dest_dir": str(dest_dir)},
        )

        assert response.status_code == 409
